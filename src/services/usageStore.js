/**
 * usageStore.js
 *
 * Acceso a las tablas `wa_usage_monthly` y `wa_tenant_config` (migración 009).
 *
 * Responsabilidad: acumular consumo mensual de proveedores de IA (Whisper,
 * Gemini) por tenant y exponer la configuración de transcripción STT para
 * que `sttService` y los endpoints del panel la puedan leer/escribir.
 *
 * Unidad interna: **micro-USD** (1e-6 USD). En la BD guardamos `usd_micros`
 * como BIGINT para poder sumar sin errores de float y sin redondear a 0 los
 * costos pequeños (una nota de voz de 30s en Whisper ≈ $0.003 = 3000 micros).
 * La API pública (`addUsage`, `getUsageByMonth`, `getUsageByYear`) habla en
 * **USD como número flotante** — la conversión a micros queda confinada aquí.
 */

const USD_MICROS = 1_000_000;

function usdToMicros(usd) {
    // Redondeo a entero; nunca negativo en la práctica.
    return Math.round(Number(usd) * USD_MICROS);
}

function microsToUsd(micros) {
    return Number(micros) / USD_MICROS;
}

/**
 * Devuelve el bucket mensual del timestamp dado en formato 'YYYY-MM'.
 * Usa UTC para que el corte de mes sea consistente entre tenants.
 */
function currentYearMonth(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * Suma consumo a la fila (year_month, provider). Si no existe la crea.
 *
 * @param {Pool}   pool       conexión del tenant
 * @param {string} provider   'whisper' | 'gemini' | …
 * @param {number} usd        costo en USD (puede ser fraccional)
 * @param {number} callCount  cuántas llamadas agregar (default 1)
 * @param {string} [yearMonth] override del mes (tests). Default: mes actual UTC.
 */
async function addUsage(pool, provider, usd, callCount = 1, yearMonth = null) {
    if (!provider) throw new Error('usageStore.addUsage: provider requerido');
    const micros = usdToMicros(usd);
    if (!Number.isFinite(micros) || micros < 0) {
        throw new Error(`usageStore.addUsage: usd inválido (${usd})`);
    }
    const ym = yearMonth || currentYearMonth();

    await pool.query(
        `INSERT INTO wa_usage_monthly (\`year_month\`, provider, usd_micros, call_count)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           usd_micros = usd_micros + VALUES(usd_micros),
           call_count = call_count + VALUES(call_count)`,
        [ym, provider, micros, callCount]
    );
}

/**
 * Devuelve el consumo de un mes desglosado por proveedor.
 * Incluye todos los proveedores presentes (no forza ceros para los faltantes).
 */
async function getUsageByMonth(pool, yearMonth = null) {
    const ym = yearMonth || currentYearMonth();
    const [rows] = await pool.query(
        `SELECT provider, usd_micros, call_count, updated_at
         FROM wa_usage_monthly
         WHERE \`year_month\` = ?`,
        [ym]
    );
    return {
        year_month: ym,
        providers: rows.map((r) => ({
            provider: r.provider,
            usd: microsToUsd(r.usd_micros),
            call_count: r.call_count,
            updated_at: r.updated_at,
        })),
    };
}

/**
 * Devuelve el consumo de un año como serie mensual por proveedor.
 * Útil para el gráfico anual del panel de Configuración.
 */
async function getUsageByYear(pool, year) {
    const y = String(year);
    const [rows] = await pool.query(
        `SELECT \`year_month\`, provider, usd_micros, call_count
         FROM wa_usage_monthly
         WHERE \`year_month\` LIKE ?
         ORDER BY \`year_month\` ASC, provider ASC`,
        [`${y}-%`]
    );
    return rows.map((r) => ({
        year_month: r.year_month,
        provider: r.provider,
        usd: microsToUsd(r.usd_micros),
        call_count: r.call_count,
    }));
}

/**
 * Lee el singleton `wa_tenant_config`. Si la fila no existe (caso raro: se
 * corrió la migración pero se borró el seed), devuelve defaults en memoria
 * para no romper los callers.
 */
async function getTenantConfig(pool) {
    const [rows] = await pool.query(
        `SELECT stt_enabled, stt_monthly_usd_limit, stt_long_audio_seconds,
                stt_language, updated_at
         FROM wa_tenant_config
         WHERE id = 1`
    );
    if (rows.length === 0) {
        return {
            stt_enabled: 1,
            stt_monthly_usd_limit: 3.00,
            stt_long_audio_seconds: 120,
            stt_language: 'es',
            updated_at: null,
        };
    }
    const r = rows[0];
    return {
        stt_enabled: r.stt_enabled,
        stt_monthly_usd_limit: Number(r.stt_monthly_usd_limit),
        stt_long_audio_seconds: r.stt_long_audio_seconds,
        stt_language: r.stt_language || '',
        updated_at: r.updated_at,
    };
}

/**
 * Actualiza parcialmente el singleton. Solo se escriben los campos presentes
 * en `patch`. Valida tipos mínimos; los chequeos de rango (ej. tope > 0)
 * los hace el controller.
 */
async function updateTenantConfig(pool, patch = {}) {
    const fields = [];
    const values = [];

    if (patch.stt_enabled !== undefined) {
        fields.push('stt_enabled = ?');
        values.push(patch.stt_enabled ? 1 : 0);
    }
    if (patch.stt_monthly_usd_limit !== undefined) {
        const n = Number(patch.stt_monthly_usd_limit);
        if (!Number.isFinite(n) || n < 0) {
            throw new Error('stt_monthly_usd_limit inválido');
        }
        fields.push('stt_monthly_usd_limit = ?');
        values.push(n);
    }
    if (patch.stt_long_audio_seconds !== undefined) {
        const n = Number(patch.stt_long_audio_seconds);
        if (!Number.isInteger(n) || n < 0) {
            throw new Error('stt_long_audio_seconds inválido');
        }
        fields.push('stt_long_audio_seconds = ?');
        values.push(n);
    }
    if (patch.stt_language !== undefined) {
        const s = String(patch.stt_language || '').trim().slice(0, 8);
        fields.push('stt_language = ?');
        values.push(s);
    }

    if (fields.length === 0) {
        return getTenantConfig(pool);
    }

    // Garantizamos que la fila exista (idempotente con el seed).
    await pool.query(`INSERT IGNORE INTO wa_tenant_config (id) VALUES (1)`);
    await pool.query(
        `UPDATE wa_tenant_config SET ${fields.join(', ')} WHERE id = 1`,
        values
    );

    return getTenantConfig(pool);
}

module.exports = {
    addUsage,
    getUsageByMonth,
    getUsageByYear,
    getTenantConfig,
    updateTenantConfig,
    currentYearMonth,
    // expuestos para tests / debug
    _usdToMicros: usdToMicros,
    _microsToUsd: microsToUsd,
};

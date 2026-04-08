/**
 * aiService.js
 *
 * Wrapper de Gemini para auto-respuestas de WhatsApp (Fase 8).
 *
 * Responsabilidad única: dado un tenant (`pool`) y una conversación (`jid`),
 * leer la configuración de IA de la empresa, armar el contexto a partir del
 * historial reciente persistido en `wa_messages`, llamar al modelo y devolver
 * el texto generado. NO envía nada por WhatsApp — el envío lo hace `waManager`
 * desde el hook que se cablea en 8.2.
 *
 * Configuración:
 *   - process.env.GEMINI_API_KEY  → key global (Opción A consensuada)
 *   - wa_ai_settings (singleton id=1) por tenant → provider, enabled, model,
 *     system_prompt, temperature, max_tokens, knowledge_base
 *
 * Decisiones tomadas en Fase 8:
 *   - Proveedor único cableado: Gemini (`@google/genai`). Anthropic queda
 *     pluggable a futuro vía la columna `provider`.
 *   - Modelo por defecto: `gemini-2.5-flash` (latencia baja, costo bajo,
 *     calidad sobrada para atención al cliente).
 *   - El servicio NO decide si "debe" responder. Esa regla (toggle global,
 *     toggle por conversación, modo human/hybrid, grupos, pausa) vive en el
 *     hook de waManager (Fase 8.2). Aquí asumimos que ya se decidió que sí.
 */

const { GoogleGenAI } = require('@google/genai');

// Cuántos mensajes de historial inyectamos al prompt. Suficiente para
// continuidad conversacional sin disparar tokens.
const DEFAULT_HISTORY_LIMIT = 12;

let _client = null;
function getClient() {
    if (_client) return _client;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY no está definida en el entorno.');
    }
    _client = new GoogleGenAI({ apiKey });
    return _client;
}

/**
 * Lee la fila singleton de wa_ai_settings. Devuelve null si IA no está
 * habilitada para el tenant.
 */
async function loadSettings(pool) {
    const [rows] = await pool.query(
        `SELECT provider, enabled, model, system_prompt, temperature,
                max_tokens, respond_in_groups, knowledge_base
         FROM wa_ai_settings WHERE id = 1`
    );
    const s = rows[0];
    if (!s) return null;
    return {
        provider: s.provider,
        enabled: !!s.enabled,
        model: s.model || 'gemini-2.5-flash',
        systemPrompt: s.system_prompt || null,
        temperature: Number(s.temperature ?? 0.3),
        maxTokens: Number(s.max_tokens ?? 1024),
        respondInGroups: !!s.respond_in_groups,
        knowledgeBase: s.knowledge_base || null,
    };
}

/**
 * Lee los últimos N mensajes de la conversación en orden cronológico ASC
 * para inyectarlos como historial al modelo.
 */
async function loadHistory(pool, jid, limit) {
    const [rows] = await pool.query(
        `SELECT from_me, body, type, ts
         FROM wa_messages
         WHERE jid = ? AND body IS NOT NULL
         ORDER BY ts DESC
         LIMIT ?`,
        [jid, limit]
    );
    return rows.reverse();
}

/**
 * Mapea filas de wa_messages al formato `contents` que espera Gemini.
 *   from_me=true  → role 'model' (lo que ya respondió el bot/empresa)
 *   from_me=false → role 'user'  (lo que escribió el contacto)
 */
function buildContents(history) {
    return history.map((m) => ({
        role: m.from_me ? 'model' : 'user',
        parts: [{ text: m.body || `[${m.type}]` }],
    }));
}

/**
 * Construye la instrucción de sistema combinando system_prompt + knowledge_base.
 */
function buildSystemInstruction(settings) {
    const parts = [];
    if (settings.systemPrompt) {
        parts.push(settings.systemPrompt.trim());
    }
    if (settings.knowledgeBase) {
        try {
            const kb = typeof settings.knowledgeBase === 'string'
                ? JSON.parse(settings.knowledgeBase)
                : settings.knowledgeBase;
            parts.push('Base de conocimiento de la empresa (usar como referencia, no copiar literal):');
            parts.push(JSON.stringify(kb, null, 2));
        } catch (_) { /* kb mal formada → ignorar */ }
    }
    if (!parts.length) {
        parts.push('Eres un asistente de atención al cliente vía WhatsApp. Responde de forma breve, amable y útil.');
    }
    return parts.join('\n\n');
}

/**
 * Genera una respuesta para una conversación.
 *
 * @param {object}  params
 * @param {Pool}    params.pool          - pool MySQL del tenant
 * @param {string}  params.jid           - jid de la conversación
 * @param {string}  [params.incomingText] - texto entrante (ya está persistido,
 *                                          se incluye sólo por trazabilidad/log)
 * @param {number}  [params.historyLimit]
 * @returns {Promise<{text:string, model:string}|null>}
 *          null si IA está deshabilitada en el tenant o si el modelo no
 *          devolvió texto.
 */
async function generateReply({ pool, jid, incomingText, historyLimit = DEFAULT_HISTORY_LIMIT }) {
    const settings = await loadSettings(pool);
    if (!settings || !settings.enabled) return null;

    // Sólo Gemini está cableado en Fase 8. Otros providers → no-op silencioso.
    if (settings.provider !== 'gemini') {
        console.warn(`[aiService] provider='${settings.provider}' no cableado, omitiendo respuesta.`);
        return null;
    }

    const history = await loadHistory(pool, jid, historyLimit);
    if (!history.length && !incomingText) return null;

    const contents = buildContents(history);
    const systemInstruction = buildSystemInstruction(settings);

    let response;
    try {
        const client = getClient();
        response = await client.models.generateContent({
            model: settings.model,
            contents,
            config: {
                systemInstruction,
                temperature: settings.temperature,
                maxOutputTokens: settings.maxTokens,
            },
        });
    } catch (e) {
        console.error(`[aiService] Gemini falló para jid=${jid}:`, e.message);
        return null;
    }

    const text = (response?.text || '').trim();
    if (!text) return null;

    return { text, model: settings.model };
}

/**
 * Actualiza dinámicamente columnas de wa_ai_settings (singleton id=1).
 * Sólo se aplican las claves whitelisteadas.
 */
const SETTINGS_WHITELIST = new Set([
    'provider', 'enabled', 'model', 'system_prompt', 'temperature',
    'max_tokens', 'respond_in_groups', 'handoff_rules', 'knowledge_base',
]);

async function updateSettings(pool, patch = {}) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
        if (!SETTINGS_WHITELIST.has(k)) continue;
        sets.push(`\`${k}\` = ?`);
        // JSON columns aceptan string o se serializan
        if ((k === 'handoff_rules' || k === 'knowledge_base') && v && typeof v !== 'string') {
            params.push(JSON.stringify(v));
        } else if (k === 'enabled' || k === 'respond_in_groups') {
            params.push(v ? 1 : 0);
        } else {
            params.push(v);
        }
    }
    if (!sets.length) return false;
    const [r] = await pool.query(
        `UPDATE wa_ai_settings SET ${sets.join(', ')} WHERE id = 1`,
        params
    );
    return r.affectedRows > 0;
}

async function setGlobalEnabled(pool, enabled) {
    return updateSettings(pool, { enabled: !!enabled });
}

module.exports = {
    generateReply,
    loadSettings,
    updateSettings,
    setGlobalEnabled,
};

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
const log = require('../lib/logger').createLogger('aiService');

// Cuántos mensajes de historial inyectamos al prompt. Suficiente para
// continuidad conversacional sin disparar tokens.
const DEFAULT_HISTORY_LIMIT = 12;

// ---------- Hardening Gemini (Fase 9.2) ----------
// Timeout duro por intento. Gemini-flash promedia 1-3s; 8s deja margen
// holgado para colas eventuales sin congelar el ingest de WhatsApp.
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 8000);

// Reintentos con backoff exponencial + jitter ante errores transientes
// (429 rate limit, 503 unavailable, timeouts, errores de red). Total
// máximo de intentos = 1 + GEMINI_RETRIES.
const GEMINI_RETRIES = Number(process.env.GEMINI_RETRIES || 2);
const GEMINI_BACKOFF_BASE_MS = 500;

// Circuit breaker global (proceso): si Gemini falla N veces consecutivas,
// abrimos el circuito durante COOLDOWN_MS para no martillar al API ni
// bloquear el ingest. Tras el cooldown pasa a half-open y un único intento
// decide si cerramos o seguimos abiertos.
const CB_FAIL_THRESHOLD = Number(process.env.GEMINI_CB_THRESHOLD || 5);
const CB_COOLDOWN_MS = Number(process.env.GEMINI_CB_COOLDOWN_MS || 60_000);

const breaker = {
    state: 'closed',       // 'closed' | 'open' | 'half-open'
    failures: 0,
    openedAt: 0,
};

function breakerCanPass() {
    if (breaker.state === 'closed') return true;
    if (breaker.state === 'open') {
        if (Date.now() - breaker.openedAt >= CB_COOLDOWN_MS) {
            breaker.state = 'half-open';
            log.warn({ cb: breaker.state }, 'circuit breaker half-open: probando 1 request');
            return true;
        }
        return false;
    }
    // half-open: deja pasar el probe
    return true;
}

function breakerOnSuccess() {
    if (breaker.state !== 'closed' || breaker.failures > 0) {
        log.info({ cb: 'closed', prevFailures: breaker.failures }, 'circuit breaker cerrado');
    }
    breaker.state = 'closed';
    breaker.failures = 0;
    breaker.openedAt = 0;
}

function breakerOnFailure() {
    breaker.failures += 1;
    if (breaker.state === 'half-open' || breaker.failures >= CB_FAIL_THRESHOLD) {
        breaker.state = 'open';
        breaker.openedAt = Date.now();
        log.error(
            { cb: 'open', failures: breaker.failures, cooldownMs: CB_COOLDOWN_MS },
            'circuit breaker ABIERTO — pausando llamadas a Gemini'
        );
    }
}

/**
 * Devuelve true si el error parece transiente y vale la pena reintentar.
 * Cubre: 429 (rate limit), 5xx, timeouts artesanales, errores de red.
 */
function isRetryable(err) {
    if (!err) return false;
    if (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return true;
    if (err.message && /timeout/i.test(err.message)) return true;
    const status = err.status || err.code || err.response?.status;
    if (status === 429 || status === 503 || status === 502 || status === 504) return true;
    return false;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Envuelve una promesa en un timeout duro. Si el timer dispara primero,
 * la promesa rechaza con un Error('Gemini timeout NNNms'). NO cancela la
 * llamada subyacente (el SDK no expone AbortController público), pero sí
 * libera el await para que el caller no quede colgado.
 */
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const e = new Error(`Gemini timeout ${ms}ms`);
            e.code = 'ETIMEDOUT';
            reject(e);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Llama a Gemini con timeout + reintentos + circuit breaker.
 * Lanza el último error si todos los intentos fallan.
 */
async function callGeminiWithResilience(client, request) {
    if (!breakerCanPass()) {
        const e = new Error('circuit breaker abierto');
        e.code = 'CIRCUIT_OPEN';
        throw e;
    }

    let lastErr;
    const maxAttempts = 1 + GEMINI_RETRIES;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await withTimeout(
                client.models.generateContent(request),
                GEMINI_TIMEOUT_MS
            );
            breakerOnSuccess();
            return res;
        } catch (e) {
            lastErr = e;
            const retryable = isRetryable(e);
            log.warn(
                { err: e, attempt, maxAttempts, retryable },
                'Gemini intento falló'
            );
            if (!retryable || attempt === maxAttempts) break;
            // Backoff exponencial + jitter (50%)
            const base = GEMINI_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
            const jitter = Math.random() * base * 0.5;
            await sleep(base + jitter);
        }
    }
    breakerOnFailure();
    throw lastErr;
}

/**
 * Devuelve el estado actual del breaker (para /health o tests).
 */
function getBreakerState() {
    return {
        state: breaker.state,
        failures: breaker.failures,
        openedAt: breaker.openedAt || null,
        cooldownRemainingMs:
            breaker.state === 'open'
                ? Math.max(0, CB_COOLDOWN_MS - (Date.now() - breaker.openedAt))
                : 0,
    };
}

/**
 * Resetea el breaker manualmente. Útil para tests o un endpoint admin.
 */
function resetBreaker() {
    breaker.state = 'closed';
    breaker.failures = 0;
    breaker.openedAt = 0;
}

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
        log.warn({ provider: settings.provider }, 'provider no cableado, omitiendo respuesta');
        return null;
    }

    const history = await loadHistory(pool, jid, historyLimit);
    if (!history.length && !incomingText) return null;

    const contents = buildContents(history);
    const systemInstruction = buildSystemInstruction(settings);

    let response;
    const startedAt = Date.now();
    try {
        const client = getClient();
        response = await callGeminiWithResilience(client, {
            model: settings.model,
            contents,
            config: {
                systemInstruction,
                temperature: settings.temperature,
                maxOutputTokens: settings.maxTokens,
            },
        });
        log.info(
            { jid, model: settings.model, durMs: Date.now() - startedAt },
            'Gemini ok'
        );
    } catch (e) {
        log.error(
            { err: e, jid, durMs: Date.now() - startedAt, code: e.code || null },
            'Gemini falló (tras retries/breaker)'
        );
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

// Wrapper indireccionado para permitir monkey-patch en tests sin tocar
// el objeto exportado. En runtime apunta al generateReply real.
let _generateReplyImpl = generateReply;
async function generateReplyExport(params) {
    return _generateReplyImpl(params);
}

module.exports = {
    generateReply: generateReplyExport,
    loadSettings,
    updateSettings,
    setGlobalEnabled,
    // Hardening (Fase 9.2)
    getBreakerState,
    resetBreaker,
    _internal: { isRetryable, withTimeout, callGeminiWithResilience },
    // Hooks de test (Fase 9.5)
    _test: {
        setGenerateReplyImpl(fn) { _generateReplyImpl = fn || generateReply; },
        restore() { _generateReplyImpl = generateReply; },
    },
};

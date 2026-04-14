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

// ---------------------------------------------------------------------------
// Agentes IA (Fase A): múltiples personalidades por tenant
// ---------------------------------------------------------------------------

/**
 * Carga un agente IA por su ID. Si agentId es null/undefined, devuelve el
 * agente marcado como is_default. Devuelve null si no encuentra ninguno.
 */
async function loadAgent(pool, agentId) {
    let rows;
    if (agentId) {
        [rows] = await pool.query(
            `SELECT id, name, slug, system_prompt, knowledge_base, model,
                    temperature, max_tokens, enabled
             FROM wa_ai_agents WHERE id = ? AND enabled = 1`,
            [agentId]
        );
    } else {
        [rows] = await pool.query(
            `SELECT id, name, slug, system_prompt, knowledge_base, model,
                    temperature, max_tokens, enabled
             FROM wa_ai_agents WHERE is_default = 1 AND enabled = 1
             LIMIT 1`
        );
    }
    const a = rows[0];
    if (!a) return null;
    return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        systemPrompt: a.system_prompt || null,
        knowledgeBase: a.knowledge_base || null,
        model: a.model || 'gemini-2.5-flash',
        temperature: Number(a.temperature ?? 0.3),
        maxTokens: Number(a.max_tokens ?? 1024),
        enabled: !!a.enabled,
    };
}

/**
 * Lista todos los agentes de un tenant.
 */
async function listAgents(pool) {
    const [rows] = await pool.query(
        `SELECT id, name, slug, system_prompt, knowledge_base, model,
                temperature, max_tokens, enabled, is_default, created_at, updated_at
         FROM wa_ai_agents ORDER BY is_default DESC, name ASC`
    );
    return rows.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        systemPrompt: a.system_prompt || null,
        knowledgeBase: a.knowledge_base || null,
        model: a.model || 'gemini-2.5-flash',
        temperature: Number(a.temperature ?? 0.3),
        maxTokens: Number(a.max_tokens ?? 1024),
        enabled: !!a.enabled,
        isDefault: !!a.is_default,
        createdAt: a.created_at,
        updatedAt: a.updated_at,
    }));
}

/**
 * Crea un nuevo agente IA. Devuelve el agente creado con su ID.
 */
async function createAgent(pool, { name, slug, systemPrompt, knowledgeBase, model, temperature, maxTokens, enabled, isDefault }) {
    // Si se marca como default, quitar el flag de los demás
    if (isDefault) {
        await pool.query(`UPDATE wa_ai_agents SET is_default = 0`);
    }
    const kb = knowledgeBase && typeof knowledgeBase !== 'string'
        ? JSON.stringify(knowledgeBase) : knowledgeBase || null;
    const [result] = await pool.query(
        `INSERT INTO wa_ai_agents (name, slug, system_prompt, knowledge_base, model, temperature, max_tokens, enabled, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            name,
            slug,
            systemPrompt || null,
            kb,
            model || 'gemini-2.5-flash',
            temperature ?? 0.3,
            maxTokens ?? 1024,
            enabled !== false ? 1 : 0,
            isDefault ? 1 : 0,
        ]
    );
    return loadAgent(pool, result.insertId);
}

/**
 * Actualiza campos de un agente existente. Solo aplica claves whitelisteadas.
 */
const AGENT_WHITELIST = new Set([
    'name', 'slug', 'system_prompt', 'knowledge_base', 'model',
    'temperature', 'max_tokens', 'enabled', 'is_default',
]);

async function updateAgent(pool, agentId, patch = {}) {
    // Si se marca como default, quitar el flag de los demás
    if (patch.is_default || patch.isDefault) {
        await pool.query(`UPDATE wa_ai_agents SET is_default = 0`);
        patch.is_default = 1;
        delete patch.isDefault;
    }
    // Normalizar camelCase a snake_case
    const normalized = {};
    if (patch.systemPrompt !== undefined) normalized.system_prompt = patch.systemPrompt;
    if (patch.knowledgeBase !== undefined) normalized.knowledge_base = patch.knowledgeBase;
    if (patch.maxTokens !== undefined) normalized.max_tokens = patch.maxTokens;
    if (patch.isDefault !== undefined) normalized.is_default = patch.isDefault ? 1 : 0;
    // Copiar los que ya vienen en snake_case
    for (const k of Object.keys(patch)) {
        if (AGENT_WHITELIST.has(k) && normalized[k] === undefined) {
            normalized[k] = patch[k];
        }
    }

    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(normalized)) {
        if (!AGENT_WHITELIST.has(k)) continue;
        sets.push(`\`${k}\` = ?`);
        if ((k === 'knowledge_base') && v && typeof v !== 'string') {
            params.push(JSON.stringify(v));
        } else if (k === 'enabled' || k === 'is_default') {
            params.push(v ? 1 : 0);
        } else {
            params.push(v);
        }
    }
    if (!sets.length) return null;
    params.push(agentId);
    await pool.query(
        `UPDATE wa_ai_agents SET ${sets.join(', ')} WHERE id = ?`,
        params
    );
    return loadAgent(pool, agentId);
}

/**
 * Elimina un agente. No permite eliminar el agente default si es el único.
 * Desvincula las conversaciones que tenían este agente asignado.
 */
async function deleteAgent(pool, agentId) {
    // Desvincular conversaciones
    await pool.query(
        `UPDATE wa_conversations SET ai_agent_id = NULL WHERE ai_agent_id = ?`,
        [agentId]
    );
    const [result] = await pool.query(
        `DELETE FROM wa_ai_agents WHERE id = ?`,
        [agentId]
    );
    return result.affectedRows > 0;
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
 * @param {number}  [params.agentId]    - ID del agente IA asignado a la
 *                                        conversación. Si se pasa, usa el prompt
 *                                        y config del agente en lugar de wa_ai_settings.
 * @returns {Promise<{text:string, model:string, agentId:number|null}|null>}
 *          null si IA está deshabilitada en el tenant o si el modelo no
 *          devolvió texto.
 */
async function generateReply({ pool, jid, incomingText, historyLimit = DEFAULT_HISTORY_LIMIT, agentId }) {
    const settings = await loadSettings(pool);
    if (!settings || !settings.enabled) return null;

    // Sólo Gemini está cableado en Fase 8. Otros providers → no-op silencioso.
    if (settings.provider !== 'gemini') {
        log.warn({ provider: settings.provider }, 'provider no cableado, omitiendo respuesta');
        return null;
    }

    // Fase A: intentar cargar el agente asignado (o el default).
    // Si existe, sus campos sobreescriben model/prompt/temperature/maxTokens.
    // Si no existe (tabla aún no migrada, o sin agentes), cae al
    // comportamiento legacy usando wa_ai_settings.
    let agent = null;
    try {
        agent = await loadAgent(pool, agentId || null);
    } catch (_) {
        // Tabla wa_ai_agents puede no existir en tenants sin migrar → fallback silencioso
    }

    const effectiveModel = agent?.model || settings.model;
    const effectiveTemp = agent ? agent.temperature : settings.temperature;
    const effectiveMaxTokens = agent ? agent.maxTokens : settings.maxTokens;
    // Fallback campo a campo: si el agente tiene el campo NULL, usa wa_ai_settings
    const effectiveSettings = agent
        ? {
            systemPrompt: agent.systemPrompt || settings.systemPrompt,
            knowledgeBase: agent.knowledgeBase || settings.knowledgeBase,
        }
        : settings;

    const history = await loadHistory(pool, jid, historyLimit);
    if (!history.length && !incomingText) return null;

    const contents = buildContents(history);
    const systemInstruction = buildSystemInstruction(effectiveSettings);

    let response;
    const startedAt = Date.now();
    try {
        const client = getClient();
        response = await callGeminiWithResilience(client, {
            model: effectiveModel,
            contents,
            config: {
                systemInstruction,
                temperature: effectiveTemp,
                maxOutputTokens: effectiveMaxTokens,
            },
        });
        log.info(
            { jid, model: effectiveModel, agentId: agent?.id || null, durMs: Date.now() - startedAt },
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

    return { text, model: effectiveModel, agentId: agent?.id || null };
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
    // Agentes IA (Fase A)
    loadAgent,
    listAgents,
    createAgent,
    updateAgent,
    deleteAgent,
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

/**
 * aiSandboxController.js — endpoints del simulador del bot de WhatsApp.
 *
 * POST /ai/sandbox/:companyId/message   un turno simulado (ver sandboxService)
 * POST /ai/sandbox/:companyId/reset     olvidar la sesión (memoria de contextEnricher)
 * GET  /ai/sandbox/:companyId/customers buscar cliente para simular "como cliente X"
 * GET  /ai/sandbox/:companyId/meta      modelos válidos, motores, estado del breaker
 */
const tenantResolver = require('../src/db/tenantResolver');
const aiService = require('../src/services/aiService');
const sandboxService = require('../src/services/sandboxService');
const { KNOWN_MODELS } = require('../src/services/geminiPricing');
const log = require('../src/lib/logger').createLogger('aiSandboxController');

const MAX_TEXT = 4000;
const MAX_PROMPT = 200000;
const SESSION_ID_RE = /^[a-f0-9-]{16,64}$/i;
const ROW_TYPES = new Set(['text', 'image', 'video', 'document', 'audio', 'sticker']);

// ── Rate limit en memoria (por usuario y por empresa) ─────────────────────
const PER_MINUTE = 20;
const PER_DAY_TENANT = 300;
const inFlight = new Set();          // userKey
const minuteHits = new Map();        // userKey → [ts]
const dayHits = new Map();           // `${empresa}:${YYYY-MM-DD}` → n

function rateLimit(userKey, idEmpresa) {
    if (inFlight.has(userKey)) return 'busy';
    const now = Date.now();
    const hits = (minuteHits.get(userKey) || []).filter((ts) => now - ts < 60_000);
    if (hits.length >= PER_MINUTE) return 'per_minute';
    const dayKey = `${idEmpresa}:${new Date().toISOString().slice(0, 10)}`;
    const n = dayHits.get(dayKey) || 0;
    if (n >= PER_DAY_TENANT) return 'per_day';
    hits.push(now);
    minuteHits.set(userKey, hits);
    if (!dayHits.has(dayKey)) {
        for (const k of dayHits.keys()) if (k.startsWith(`${idEmpresa}:`)) dayHits.delete(k);
    }
    dayHits.set(dayKey, n + 1);
    return null;
}

// ── Validación de entrada ─────────────────────────────────────────────────
function validateHistory(history) {
    if (history == null) return [];
    if (!Array.isArray(history)) throw badRequest('history debe ser un arreglo');
    return history.slice(-sandboxService.MAX_HISTORY_ROWS).map((m) => {
        const type = ROW_TYPES.has(m?.type) ? m.type : 'text';
        const body = m?.body == null ? null : String(m.body).slice(0, MAX_TEXT);
        return { from_me: m?.from_me ? 1 : 0, type, body };
    });
}

function validateState(state) {
    const s = state && typeof state === 'object' ? state : {};
    const pending = s.pendingPresupuesto;
    return {
        pendingPresupuesto: pending && typeof pending === 'object' ? pending : null,
        confirmSinMarker: !!s.confirmSinMarker,
        galleryClarification: !!s.galleryClarification,
    };
}

function validateDraft(draft) {
    if (!draft) return null;
    if (typeof draft !== 'object') throw badRequest('draft inválido');
    const out = {};
    if (draft.systemPrompt != null) {
        out.systemPrompt = String(draft.systemPrompt).slice(0, MAX_PROMPT);
    }
    if (draft.knowledgeBase != null && draft.knowledgeBase !== '') {
        let kb = draft.knowledgeBase;
        if (typeof kb === 'string') {
            try { kb = JSON.parse(kb); } catch (_) { throw badRequest('knowledgeBase no es JSON válido'); }
        }
        out.knowledgeBase = kb;
    }
    if (draft.model != null) {
        if (!KNOWN_MODELS.includes(draft.model)) throw badRequest(`modelo no permitido: ${draft.model}`);
        out.model = draft.model;
    }
    if (draft.temperature != null) {
        const t = Number(draft.temperature);
        if (!Number.isFinite(t) || t < 0 || t > 2) throw badRequest('temperature fuera de rango (0-2)');
        out.temperature = t;
    }
    if (draft.maxTokens != null) {
        const n = Number(draft.maxTokens);
        if (!Number.isInteger(n) || n < 1 || n > 8192) throw badRequest('maxTokens fuera de rango (1-8192)');
        out.maxTokens = n;
    }
    return Object.keys(out).length ? out : null;
}

function validateAsCustomer(asCustomer) {
    if (!asCustomer) return null;
    if (asCustomer.customerId) return { customerId: Number(asCustomer.customerId) };
    const digits = String(asCustomer.phone || '').replace(/\D/g, '');
    if (digits.length >= 7) return { phone: digits };
    return null;
}

function badRequest(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

// ── Handlers ──────────────────────────────────────────────────────────────
async function sandboxMessage(req, res) {
    const idEmpresa = Number(req.params.companyId);
    const userId = Number(req.user.id_usuario);
    const userKey = `${idEmpresa}:${userId}`;
    const body = req.body || {};

    let params;
    try {
        const text = String(body.text || '').trim();
        if (!text) throw badRequest('text requerido');
        if (text.length > MAX_TEXT) throw badRequest(`text excede ${MAX_TEXT} caracteres`);
        const sessionId = body.sessionId || sandboxService.newSessionId();
        if (!SESSION_ID_RE.test(sessionId)) throw badRequest('sessionId inválido');
        params = {
            idEmpresa,
            sessionId,
            text,
            history: validateHistory(body.history),
            state: validateState(body.state),
            agentId: body.agentId ? Number(body.agentId) : null,
            draft: validateDraft(body.draft),
            asCustomer: validateAsCustomer(body.asCustomer),
            engine: body.engine || 'msg_ninesys',
        };
        if (!sandboxService.ENGINES.includes(params.engine)) throw badRequest(`engine no soportado: ${params.engine}`);
    } catch (e) {
        return res.status(e.status || 400).json({ message: e.message });
    }

    if (!sandboxService.touchSession(params.sessionId, idEmpresa, userId)) {
        return res.status(403).json({ message: 'La sesión de simulación pertenece a otro usuario.' });
    }
    const limited = rateLimit(userKey, idEmpresa);
    if (limited) {
        const msg = {
            busy: 'Espera a que termine la respuesta anterior.',
            per_minute: `Máximo ${PER_MINUTE} mensajes por minuto en el simulador.`,
            per_day: `La empresa alcanzó el máximo diario de ${PER_DAY_TENANT} mensajes de simulación.`,
        }[limited];
        return res.status(429).json({ message: msg, reason: limited });
    }

    inFlight.add(userKey);
    try {
        const pool = await tenantResolver.getPool(idEmpresa);
        const result = await sandboxService.simulateTurn({ ...params, pool });
        log.info({ tenantId: idEmpresa, userId, sessionId: params.sessionId, ms: result.turn.trace.totalMs }, 'sandbox: turno simulado');
        res.status(200).json({ sessionId: params.sessionId, ...result });
    } catch (e) {
        log.error({ err: e, tenantId: idEmpresa }, 'sandboxMessage falló');
        res.status(500).json({ message: 'Error en el simulador', error: e.message });
    } finally {
        inFlight.delete(userKey);
    }
}

async function sandboxReset(req, res) {
    const idEmpresa = Number(req.params.companyId);
    const sessionId = req.body?.sessionId;
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
        return res.status(400).json({ message: 'sessionId inválido' });
    }
    const ok = sandboxService.resetSession(sessionId, idEmpresa, Number(req.user.id_usuario));
    if (!ok) return res.status(403).json({ message: 'La sesión de simulación pertenece a otro usuario.' });
    res.status(200).json({ success: true, sessionId: sandboxService.newSessionId() });
}

async function sandboxCustomers(req, res) {
    const idEmpresa = Number(req.params.companyId);
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.status(200).json([]);
    try {
        const pool = await tenantResolver.getPool(idEmpresa);
        const like = `%${q.toLowerCase()}%`;
        const digits = q.replace(/\D/g, '');
        const [rows] = await pool.query(
            `SELECT _id, first_name, last_name, phone, cedula
             FROM customers
             WHERE _id <> 1
               AND (LOWER(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))) LIKE ?
                    OR LOWER(COALESCE(cedula, '')) LIKE ?
                    OR (? <> '' AND COALESCE(phone, '') LIKE ?))
             ORDER BY first_name, last_name
             LIMIT 10`,
            [like, like, digits, `%${digits}%`]
        );
        res.status(200).json(rows.map((r) => ({
            id: r._id,
            nombre: [r.first_name, r.last_name].filter(Boolean).join(' ').trim(),
            phone: r.phone || null,
            cedula: r.cedula || null,
        })));
    } catch (e) {
        log.error({ err: e, tenantId: idEmpresa }, 'sandboxCustomers falló');
        res.status(500).json({ message: 'Error buscando clientes', error: e.message });
    }
}

async function sandboxMeta(req, res) {
    res.status(200).json({
        models: KNOWN_MODELS,
        engines: sandboxService.ENGINES,
        breaker: aiService.getBreakerState(),
        limits: { perMinute: PER_MINUTE, perDayTenant: PER_DAY_TENANT, maxText: MAX_TEXT },
    });
}

module.exports = {
    sandboxMessage,
    sandboxReset,
    sandboxCustomers,
    sandboxMeta,
    _test: { validateDraft, validateHistory, validateState, rateLimit, inFlight, minuteHits, dayHits },
};

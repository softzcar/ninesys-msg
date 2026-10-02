/**
 * sandboxService.js
 *
 * Simulador del bot de WhatsApp: ejecuta un turno de conversación con la
 * MISMA lógica que producción (aiService.generateReply + contextEnricher +
 * clasificador de handoff + aiReplyPlanner) pero sin efectos laterales:
 *
 *   - nunca envía por Baileys ni escribe en wa_messages / wa_conversations /
 *     wa_send_log / customers / presupuestos;
 *   - nunca hace handoff ni notifica vendedores;
 *   - lo que producción HARÍA se devuelve como `actions` (would_handoff,
 *     would_create_presupuesto, would_update_notifications, ...).
 *
 * El historial y el estado de la conversación viajan en cada request (los
 * guarda el navegador). El servidor sólo recuerda la sesión para limpiar la
 * memoria de productos cotizados de contextEnricher (indexada por jid).
 *
 * Única escritura: el costo de Gemini se contabiliza en wa_usage_monthly con
 * provider 'gemini_sandbox' (separado del bot real).
 */

const crypto = require('crypto');
const aiService = require('./aiService');
const presupuestoService = require('./presupuestoService');
const customerLookup = require('./customerLookup');
const galleryClient = require('../lib/galleryClient');
const intentClassifier = require('../lib/intentClassifier');
const contextEnricher = require('../lib/contextEnricher');
const {
    TEXTS, OPT_OUT_COMMANDS, OPT_IN_COMMANDS,
    buildClienteRegistradoCtx, planAiReply, planConfirmation,
} = require('../lib/aiReplyPlanner');
const log = require('../lib/logger').createLogger('sandboxService');

const ENGINES = { msg_ninesys: runMsgNinesys };
const HISTORY_LIMIT = 30;        // = DEFAULT_HISTORY_LIMIT de aiService
const MAX_HISTORY_ROWS = 60;     // lo que se guarda/acepta del navegador
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_STATE = Object.freeze({
    pendingPresupuesto: null,
    confirmSinMarker: false,
    galleryClarification: false,
});

// sessionId → { idEmpresa, userId, lastSeen }
const sessions = new Map();

// jid sintético: sin dígitos sueltos que customerLookup pueda tomar por un
// teléfono. Sólo se usa como clave de memoria de contextEnricher.
function sessionJid(sessionId) {
    return `sandbox-${String(sessionId).replace(/[^a-z0-9]/gi, '')}@sandbox.local`;
}

function newSessionId() {
    return crypto.randomUUID();
}

/** Registra/valida la sesión. Devuelve false si pertenece a otro usuario/empresa. */
function touchSession(sessionId, idEmpresa, userId) {
    const s = sessions.get(sessionId);
    if (s && (s.idEmpresa !== idEmpresa || s.userId !== userId)) return false;
    sessions.set(sessionId, { idEmpresa, userId, lastSeen: Date.now() });
    return true;
}

function resetSession(sessionId, idEmpresa, userId) {
    const s = sessions.get(sessionId);
    if (s && (s.idEmpresa !== idEmpresa || s.userId !== userId)) return false;
    contextEnricher.clearShownProducts(sessionJid(sessionId));
    sessions.delete(sessionId);
    return true;
}

function sweepSessions(now = Date.now()) {
    for (const [id, s] of sessions) {
        if (now - s.lastSeen > SESSION_TTL_MS) {
            contextEnricher.clearShownProducts(sessionJid(id));
            sessions.delete(id);
        }
    }
}
setInterval(sweepSessions, SWEEP_INTERVAL_MS).unref();

/** Datos del "cliente" con el que se simula (por ID o por teléfono). */
async function resolveAsCustomer(pool, asCustomer) {
    if (!asCustomer) return { customer: null, phone: null };
    if (asCustomer.customerId) {
        const [rows] = await pool.query(
            `SELECT _id, first_name, last_name, phone, cedula, address, email
             FROM customers WHERE _id = ?`,
            [Number(asCustomer.customerId)]
        );
        return { customer: rows[0] || null, phone: rows[0]?.phone || null };
    }
    if (asCustomer.phone) {
        const digits = String(asCustomer.phone).replace(/\D/g, '');
        const customer = await customerLookup.findCustomerByJid(pool, `${digits}@s.whatsapp.net`);
        return { customer, phone: digits };
    }
    return { customer: null, phone: null };
}

/**
 * Ejecuta un turno simulado.
 *
 * @param {object} p
 * @param {number} p.idEmpresa
 * @param {Pool}   p.pool
 * @param {string} p.sessionId
 * @param {string} p.text            mensaje del "cliente"
 * @param {Array}  p.history         filas {from_me, body, type} previas
 * @param {object} p.state           estado de la conversación (ver DEFAULT_STATE)
 * @param {number} [p.agentId]
 * @param {object} [p.draft]         overrides de borrador para generateReply
 * @param {object} [p.asCustomer]    {customerId} | {phone}
 * @param {string} [p.engine='msg_ninesys']
 * @returns {Promise<{history, state, turn}>}
 */
async function simulateTurn(p) {
    const engine = p.engine || 'msg_ninesys';
    const run = ENGINES[engine];
    if (!run) {
        const e = new Error(`engine no soportado: ${engine}`);
        e.code = 'engine_not_supported';
        throw e;
    }
    return run(p);
}

async function runMsgNinesys({ idEmpresa, pool, sessionId, text, history = [], state = {}, agentId = null, draft = null, asCustomer = null }) {
    const startedAt = Date.now();
    const jid = sessionJid(sessionId);
    const st = { ...DEFAULT_STATE, ...state };
    const hist = [...history, { from_me: 0, type: 'text', body: text }];
    const messages = [];   // lo que vería el cliente
    const actions = [];    // lo que producción haría
    const trace = { engine: 'msg_ninesys', stages: {} };

    const say = (body, via = 'ai') => messages.push({
        type: 'text', body: via === 'api' ? body + TEXTS.API_FOOTER : body, via,
    });
    const finish = () => {
        for (const m of messages) hist.push({ from_me: 1, type: m.type, body: m.body });
        trace.totalMs = Date.now() - startedAt;
        return {
            history: hist.slice(-MAX_HISTORY_ROWS),
            state: st,
            turn: { at: new Date().toISOString(), userText: text, messages, actions, trace },
        };
    };

    // ── Comandos de suscripción (BAJA / ALTA): no llegan a la IA ──────────
    const cleanText = text.trim().toUpperCase();
    const isOptOut = OPT_OUT_COMMANDS.includes(cleanText);
    if (isOptOut || OPT_IN_COMMANDS.includes(cleanText)) {
        actions.push({ type: 'would_update_notifications', value: isOptOut ? 0 : 1 });
        say(isOptOut ? TEXTS.OPT_OUT : TEXTS.OPT_IN, 'api');
        trace.path = 'subscription_command';
        return finish();
    }

    // ── Cliente simulado ──────────────────────────────────────────────────
    let t = Date.now();
    const { customer, phone } = await resolveAsCustomer(pool, asCustomer).catch((err) => {
        log.warn({ idEmpresa, err: err.message }, 'sandbox: no se pudo resolver el cliente simulado');
        return { customer: null, phone: null };
    });
    const built = buildClienteRegistradoCtx(customer);
    const registeredPhone = built.registeredPhone || phone || null;
    trace.customer = customer
        ? { id: customer._id, nombre: built.nombre, phone: customer.phone || null }
        : (phone ? { id: null, nombre: null, phone } : null);
    if (customer) {
        // En producción, un chat NUEVO de un cliente con vendedor histórico se
        // asigna a ese vendedor y la IA no responde. Sólo se informa.
        const vendorId = await customerLookup.findLastEligibleVendor(pool, customer._id).catch(() => null);
        if (vendorId) {
            actions.push({ type: 'note_auto_assign', vendorId });
        }
    }
    trace.stages.customerMs = Date.now() - t;

    // ── Confirmación de presupuesto pendiente ("SÍ") ──────────────────────
    const conf = planConfirmation({
        pendingPres: st.pendingPresupuesto,
        confirmSinMarker: st.confirmSinMarker,
        body: text,
    });
    trace.confirmation = conf.action;
    if (conf.action === 'submit') {
        const data = st.pendingPresupuesto;
        st.pendingPresupuesto = null;
        t = Date.now();
        const preview = await presupuestoService.preview({ idEmpresa, pool, data });
        trace.stages.presupuestoPreviewMs = Date.now() - t;
        actions.push({ type: 'would_create_presupuesto', data, preview, customerId: built.customerId });
        if (preview.ok) {
            say(TEXTS.PRESUPUESTO_OK('SIMULADO'), 'api');
            contextEnricher.clearShownProducts(jid);
            actions.push({ type: 'would_handoff', reason: 'presupuesto_generado' });
        } else {
            say(preview.reason === 'invalid_catalog' ? TEXTS.PRESUPUESTO_INVALID_CATALOG : TEXTS.PRESUPUESTO_ERROR, 'api');
            actions.push({ type: 'would_handoff', reason: 'presupuesto_error' });
        }
        trace.path = 'presupuesto_confirmation';
        return finish();
    }
    if (conf.action === 'cancel_pending') {
        st.pendingPresupuesto = null;
        actions.push({ type: 'pending_presupuesto_cancelled' });
    }
    if (conf.action === 'retry_with_instruction') {
        actions.push({ type: 'retry_confirm_instruction' });
    }

    // ── Entradas derivadas del historial (equivalentes a las queries de maybeAutoReply) ──
    const recentClientMessages = hist
        .filter((m) => !m.from_me && m.body && m.body !== text)
        .slice(-3)
        .map((m) => m.body);
    const excludeGalleryUrls = [...new Set(hist
        .filter((m) => m.type === 'image' && String(m.body || '').startsWith(`${galleryClient.CDN_URL}/`))
        .map((m) => m.body))];
    const forceGallery = !!st.galleryClarification;
    st.galleryClarification = false;
    const extraSystemContext = [built.ctx, conf.extraCtx].filter(Boolean).join('\n');

    // ── IA + clasificador de handoff en paralelo (como producción) ────────
    const aiTrace = {};
    t = Date.now();
    const [intentResult, reply] = await Promise.all([
        intentClassifier.classifyHandoffIntent(text, recentClientMessages).then((r) => {
            trace.stages.handoffClassifierMs = Date.now() - t;
            return r;
        }),
        aiService.generateReply({
            pool,
            jid,
            resolvedJid: jid,
            incomingText: text,
            agentId: agentId || null,
            idEmpresa,
            extraSystemContext,
            excludeGalleryUrls,
            registeredPhone,
            forceGallery,
            history: hist.slice(-HISTORY_LIMIT),
            overrides: draft,
            ignoreEnabled: true,
            isolated: true,
            usageProvider: 'gemini_sandbox',
            trace: aiTrace,
        }).then((r) => {
            trace.stages.generateReplyMs = Date.now() - t;
            return r;
        }),
    ]);
    trace.handoffIntent = intentResult;
    trace.ai = aiTrace;

    // ── Interpretación (mismo módulo que producción) ─────────────────────
    const plan = await planAiReply({
        reply,
        intentResult,
        cdnUrl: galleryClient.CDN_URL,
        urlToGalleryTerm: contextEnricher._urlToGalleryTerm,
        listFolders: () => galleryClient.listFolders(idEmpresa),
    });
    trace.plan = {
        kind: plan.kind,
        rawText: plan.rawText,
        textToSend: plan.textToSend,
        gallerySource: plan.gallerySource,
        invalidGalleryUrl: plan.invalidGalleryUrl,
        stateOps: plan.stateOps.map((o) => o.op),
        notes: plan.notes.map((n) => `${n.level}: ${n.msg}`),
    };

    for (const op of plan.stateOps) {
        if (op.op === 'set_pending_presupuesto') st.pendingPresupuesto = op.data;
        else if (op.op === 'clear_confirm_sin_marker') st.confirmSinMarker = false;
        else if (op.op === 'set_confirm_sin_marker') st.confirmSinMarker = true;
        else if (op.op === 'set_gallery_clarification') st.galleryClarification = true;
    }

    if (plan.kind !== 'reply') {
        say(plan.textToSend);
        if (plan.kind !== 'human_request') actions.push({ type: 'fallback', kind: plan.kind });
    } else {
        if (plan.textToSend) say(plan.textToSend);
        for (const url of plan.imgUrls) {
            messages.push({ type: 'image', body: url, via: 'ai' });
        }
        if (plan.presupuesto) {
            actions.push({
                type: 'presupuesto_pendiente',
                source: plan.presupuesto.source,
                data: plan.presupuesto.data,
                parseError: plan.presupuesto.parseError,
            });
        }
        if (plan.handoff?.transitionText) say(plan.handoff.transitionText);
    }
    if (plan.handoff) {
        actions.push({ type: 'would_handoff', reason: plan.handoff.reason, trigger: plan.handoff.trigger });
    }

    trace.path = 'ai';
    return finish();
}

module.exports = {
    ENGINES: Object.keys(ENGINES),
    DEFAULT_STATE,
    MAX_HISTORY_ROWS,
    newSessionId,
    sessionJid,
    touchSession,
    resetSession,
    simulateTurn,
    _test: { sessions, sweepSessions },
};

/**
 * waManager.js
 *
 * Gestor multi-tenant de sesiones Baileys para msg_ninesys.
 *
 * Mantiene un Map { idEmpresa → { sock, status, qr, lastError, info } } y
 * expone una API estable que el resto del servicio (rutas HTTP, websocket
 * Socket.IO, AI router) consume sin saber qué librería WhatsApp hay debajo.
 *
 * Mapeo al contrato congelado en docs/API_CONTRACT.md:
 *   - getSessionInfo(id)   →  GET /session-info/:companyId
 *   - getStatus(id)        →  GET /ws-info/:companyId
 *   - getQr(id)            →  GET /qr/64/:companyId
 *   - init(id)             →  llamado por subscribe / session-info
 *   - restart(id)          →  POST /restart/:companyId
 *   - disconnect(id)       →  DELETE /disconnect/:companyId
 *   - destroy(id)          →  DELETE /client/:companyId
 *   - sendText(id, jid, body) → /send-message-* (helpers en otra capa)
 *
 * Eventos emitidos vía Socket.IO en la sala `company-<id>`:
 *   - 'qr'           { qr: 'data:image/png;base64,...' }
 *   - 'ready'        { ws_ready: true }
 *   - 'status'       { status, message, pausedUntil? }
 *   - 'disconnected' { reason }
 *   - 'error'        { message }
 *
 * IMPORTANTE: este archivo es PoC. No reemplaza todavía a
 * controllers/whatsappController.js — se integrará en Fase 5 detrás de un
 * feature flag (USE_BAILEYS=1).
 */

const QRCode = require('qrcode');
const tenantResolver = require('../db/tenantResolver');
const { useMySQLAuthState } = require('./baileysAuthState');
const conversationStore = require('./conversationStore');
const mediaStore = require('./mediaStore');
const aiService = require('./aiService');
const log = require('../lib/logger').createLogger('waManager');

// Throttle anti-loop por jid: máximo 1 auto-respuesta IA cada N ms.
const AI_THROTTLE_MS = 4000;
const _aiLastReply = new Map(); // jid → ts ms

// ---------- Hardening Baileys (Fase 9.3) ----------
// Backoff exponencial en reconexión: 1.5s → 3s → 6s → 12s → ... cap 60s.
// Se resetea a 0 cuando la sesión llega a READY.
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = Number(process.env.BAILEYS_MAX_RECONNECT || 20);

function computeBackoff(attempt) {
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, attempt - 1), RECONNECT_MAX_MS);
    const jitter = Math.random() * base * 0.3;
    return Math.floor(base + jitter);
}

// Flag de shutdown: cuando está en true, los handlers de `connection.close`
// no intentan reconectar para no pelearse con el graceful shutdown.
let _shuttingDown = false;

let baileys;
function loadBaileys() {
    if (!baileys) {
        // require diferido para no romper el arranque si la dep no está aún
        baileys = require('baileys');
    }
    return baileys;
}

// id_empresa → session
const sessions = new Map();

// io de Socket.IO se inyecta desde app.js / websocket.js
let ioRef = null;
function setIo(io) {
    ioRef = io;
}

function emit(idEmpresa, event, payload) {
    if (!ioRef) return;
    ioRef.to(`company-${idEmpresa}`).emit(event, payload);
}

function getSession(idEmpresa) {
    return sessions.get(parseInt(idEmpresa, 10));
}

/**
 * Persiste estado de sesión en wa_session_state (singleton).
 */
async function persistState(pool, patch) {
    const fields = [];
    const values = [];
    for (const k of Object.keys(patch)) {
        fields.push(`\`${k}\` = ?`);
        values.push(patch[k]);
    }
    if (!fields.length) return;
    await pool.query(
        `UPDATE wa_session_state SET ${fields.join(', ')} WHERE id = 1`,
        values
    );
}

/**
 * Evalúa la regla de auto-respuesta IA y, si pasa, genera y envía la
 * respuesta. Best-effort: cualquier error se loguea pero NO interrumpe el
 * pipeline de ingest.
 *
 * Regla (Fase 8):
 *   1. wa_ai_settings.enabled  (toggle global del tenant)            ← en aiService
 *   2. wa_conversations.ai_enabled  (toggle por conversación)
 *   3. wa_conversations.mode != 'human'  (no estamos en modo humano)
 *   4. !is_group  (grupos quedan fuera de Fase 8 por decisión del usuario)
 *   5. throttle: no responder si ya respondimos a este jid en los últimos
 *      AI_THROTTLE_MS milisegundos (anti-loop)
 *
 * El paso 1 lo evalúa aiService.generateReply leyendo wa_ai_settings, así
 * que aquí sólo aplicamos los pasos 2-5 antes de invocarlo.
 */
async function maybeAutoReply(idEmpresa, pool, ingestResult) {
    try {
        const incoming = ingestResult?.message;
        const jid = ingestResult?.jid;
        if (!incoming || !jid || incoming.from_me) return;

        const flags = await conversationStore.getConversationFlags(pool, jid);
        if (!flags) return;
        if (flags.isGroup) return;            // Fase 8: grupos fuera
        if (flags.mode === 'human') return;   // empleado tomó la conversación
        if (!flags.aiEnabled) return;         // toggle por conversación off

        // Throttle anti-loop por jid
        const now = Date.now();
        const last = _aiLastReply.get(jid) || 0;
        if (now - last < AI_THROTTLE_MS) return;
        _aiLastReply.set(jid, now);

        const reply = await aiService.generateReply({
            pool,
            jid,
            incomingText: incoming.body,
            agentId: flags.aiAgentId || null,
        });
        if (!reply) return;

        try {
            await sendText(idEmpresa, jid, reply.text, { via: 'ai' });
            await pool.query(
                `INSERT INTO wa_send_log (endpoint, phone, status, requested_by)
                 VALUES (?, ?, 'ok', ?)`,
                ['ai_auto', jid, `gemini:${reply.model}`]
            );
        } catch (sendErr) {
            await pool.query(
                `INSERT INTO wa_send_log (endpoint, phone, status, error, requested_by)
                 VALUES (?, ?, 'error', ?, ?)`,
                ['ai_auto', jid, sendErr.message, `gemini:${reply.model}`]
            ).catch(() => {});
            throw sendErr;
        }
    } catch (e) {
        log.error({ err: e, tenantId: idEmpresa }, 'maybeAutoReply falló');
    }
}

/**
 * Inicializa (o re-inicializa) la sesión Baileys de una empresa.
 * Idempotente: si ya hay un socket abierto, lo devuelve.
 */
async function init(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const existing = sessions.get(id);
    const REUSABLE = ['INITIALIZING', 'REQUIRES_QR', 'AUTHENTICATED', 'READY'];
    if (existing && existing.sock && REUSABLE.includes(existing.status)) {
        return existing;
    }

    const {
        default: makeWASocket,
        DisconnectReason,
        fetchLatestBaileysVersion,
    } = loadBaileys();

    const pool = await tenantResolver.getPool(id);
    const { state, saveCreds, clear } = await useMySQLAuthState(pool);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        browser: ['msg_ninesys', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
    });

    // Preservamos reconnectAttempts entre inits consecutivos para que el
    // backoff escale correctamente en un ciclo de fallos.
    const prev = sessions.get(id);
    const session = {
        sock,
        clear,
        status: 'INITIALIZING',
        qr: null,
        lastError: null,
        info: null,
        pausedUntil: null,
        reconnectAttempts: prev?.reconnectAttempts || 0,
    };
    sessions.set(id, session);
    await persistState(pool, { status: 'INITIALIZING', last_error: null });
    emit(id, 'status', { status: 'INITIALIZING', message: 'Inicializando cliente...' });

    sock.ev.on('creds.update', saveCreds);

    // ---------- Persistencia de conversaciones / mensajes (Fase 6) ----------
    // Fase B.1: handler de descarga de media. Se inyecta a ingestMessage solo
    // para eventos 'notify' (mensajes nuevos) — evitamos descargar el histórico
    // en 'append'.
    const { downloadMediaMessage } = loadBaileys();
    const mediaHandler = async ({ msg, type, waMessageId, ts }) => {
        try {
            const buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                { reuploadRequest: sock.updateMediaMessage }
            );
            if (!buffer || !buffer.length) return null;
            const mimeType =
                msg.message?.imageMessage?.mimetype
                || msg.message?.audioMessage?.mimetype
                || msg.message?.videoMessage?.mimetype
                || msg.message?.documentMessage?.mimetype
                || msg.message?.stickerMessage?.mimetype
                || 'application/octet-stream';
            const saved = mediaStore.saveBuffer({
                companyId: id,
                waMessageId,
                buffer,
                mimeType,
                ts,
            });
            return { relativePath: saved.relativePath, mimeType: saved.mimeType };
        } catch (e) {
            log.warn({ err: e, wa_message_id: waMessageId, type, tenantId: id },
                'descarga de media falló');
            return null;
        }
    };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // type: 'notify' (mensaje nuevo entrante) | 'append' (sync histórico)
        for (const m of messages || []) {
            try {
                const result = await conversationStore.ingestMessage(pool, m, {
                    mediaHandler: type === 'notify' ? mediaHandler : undefined,
                    log,
                });
                if (!result) continue;
                if (type === 'notify') {
                    emit(id, 'message:new', { companyId: id, ...result.message, jid: result.jid });
                    emit(id, 'conversation:updated', { companyId: id, ...result.conversation });
                    // Fase 8: auto-respuesta IA (best-effort, no bloquea el ingest)
                    if (!result.message.from_me) {
                        maybeAutoReply(id, pool, result);
                    }
                }
            } catch (e) {
                log.error({ err: e, tenantId: id }, 'ingestMessage falló');
            }
        }
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const u of updates || []) {
            const wa_message_id = u.key?.id;
            const status = u.update?.status;
            // Baileys status: 0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED
            const statusMap = { 0: 'failed', 1: 'pending', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read' };
            const mapped = statusMap[status];
            if (wa_message_id && mapped) {
                try {
                    await conversationStore.updateMessageStatus(pool, wa_message_id, mapped);
                    emit(id, 'message:status', { companyId: id, wa_message_id, status: mapped });
                } catch (e) {
                    log.error({ err: e, tenantId: id, wa_message_id }, 'updateMessageStatus falló');
                }
            }
        }
    });

    sock.ev.on('chats.upsert', async (chats) => {
        try {
            await conversationStore.upsertChatNames(pool, chats);
        } catch (e) {
            log.error({ err: e, tenantId: id }, 'upsertChatNames falló');
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const dataUrl = await QRCode.toDataURL(qr);
                session.qr = dataUrl;
                session.status = 'REQUIRES_QR';
                await persistState(pool, { status: 'REQUIRES_QR' });
                emit(id, 'qr', { qr: dataUrl });
            } catch (e) {
                log.error({ err: e, tenantId: id }, 'Error generando QR base64');
            }
        }

        if (connection === 'open') {
            session.status = 'READY';
            session.qr = null;
            session.info = sock.user || null;
            session.lastError = null;
            session.reconnectAttempts = 0; // reset backoff al reconectar ok
            await persistState(pool, {
                status: 'READY',
                phone_number: sock.user?.id?.split(':')[0] || null,
                pushname: sock.user?.name || null,
                last_seen_at: new Date(),
                last_error: null,
            });
            emit(id, 'ready', { ws_ready: true });
            emit(id, 'status', { status: 'READY', message: 'Cliente listo.' });
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason[code] || `code:${code}`;
            // Si esta sesión ya no es la activa en el mapa significa que
            // otro init()/restart() tomó el relevo. No tocamos estado
            // persistente ni reintentamos reconexión — es un close tardío
            // de un socket obsoleto.
            if (sessions.get(id) !== session) {
                log.info({ tenantId: id, reason }, 'Close de socket obsoleto, ignorando');
                return;
            }
            session.status = 'DISCONNECTED';
            session.lastError = lastDisconnect?.error?.message || null;
            await persistState(pool, {
                status: 'DISCONNECTED',
                last_error: session.lastError,
            });
            emit(id, 'disconnected', { reason });

            // Re-conectar excepto si fue logout explícito o si estamos en shutdown
            if (_shuttingDown) {
                log.info({ tenantId: id, reason }, 'Close durante shutdown, no reconectando');
            } else if (code !== DisconnectReason.loggedOut) {
                session.reconnectAttempts += 1;
                if (session.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
                    session.status = 'DEGRADED';
                    await persistState(pool, {
                        status: 'DEGRADED',
                        last_error: `Reconexión agotada tras ${RECONNECT_MAX_ATTEMPTS} intentos`,
                    });
                    emit(id, 'status', {
                        status: 'DEGRADED',
                        message: `Reconexión agotada tras ${RECONNECT_MAX_ATTEMPTS} intentos. Requiere restart manual.`,
                    });
                    log.error(
                        { tenantId: id, attempts: session.reconnectAttempts },
                        'Reconexión agotada — estado DEGRADED'
                    );
                } else {
                    const delay = computeBackoff(session.reconnectAttempts);
                    log.info(
                        { tenantId: id, reason, attempt: session.reconnectAttempts, delayMs: delay },
                        'Reconectando sesión con backoff'
                    );
                    setTimeout(() => {
                        if (_shuttingDown) return;
                        init(id).catch((e) => {
                            log.error({ err: e, tenantId: id }, 'Reconexión falló');
                            emit(id, 'error', { message: e.message });
                        });
                    }, delay);
                }
            } else {
                // Logout: limpiar credenciales y dejar listo para nuevo QR
                try { await clear(); } catch (_) {}
                sessions.delete(id);
                await persistState(pool, { status: 'NOT_REGISTERED' });
            }
        }
    });

    return session;
}

/**
 * Forma para GET /session-info/:companyId.
 */
async function getSessionInfo(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    let s = sessions.get(id);
    if (!s) {
        s = await init(id);
    }

    if (s.status === 'PAUSED') {
        return {
            status: 'PAUSED',
            ws_ready: false,
            qr: null,
            pausedUntil: s.pausedUntil,
            message: 'Sesión pausada temporalmente.',
        };
    }

    if (s.status === 'READY') {
        return {
            qr: null,
            ws_ready: true,
            message: `Cliente de WhatsApp listo para la compañía ID ${id}.`,
            info: s.info ? {
                id: s.info.id,
                number: (s.info.id || '').split(':')[0],
                platform: 'baileys',
                pushname: s.info.name || null,
            } : null,
        };
    }

    if (s.qr) {
        return {
            qr: s.qr,
            ws_ready: false,
            message: `Escanee el código QR para la compañía ID ${id}.`,
        };
    }

    return {
        qr: null,
        ws_ready: false,
        status: s.status,
        message: `Sesión en estado ${s.status}.`,
    };
}

/**
 * Forma para GET /ws-info/:companyId (sin auth).
 */
function getStatus(idEmpresa) {
    const s = sessions.get(parseInt(idEmpresa, 10));
    if (!s) {
        return {
            status: 'NOT_REGISTERED',
            ws_ready: false,
            qr: null,
            message: 'Sin sesión registrada.',
        };
    }
    return {
        status: s.status,
        ws_ready: s.status === 'READY',
        qr: s.qr || null,
        message: s.lastError || `Estado: ${s.status}`,
    };
}

async function restart(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const s = sessions.get(id);
    if (s?.sock) {
        // Evitamos que el connection.update del socket viejo (que se va a
        // cerrar) dispare el handler de reconexión/cleanup mientras el nuevo
        // init() ya está levantando el socket — condición de carrera que
        // puede borrar credenciales nuevas o eliminar la sesión recién
        // creada del Map.
        try { s.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
        try { s.sock.end(new Error('restart')); } catch (_) {}
    }
    sessions.delete(id);
    return init(id);
}

async function disconnect(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const s = sessions.get(id);
    if (!s) return { ok: true, message: 'No había sesión activa.' };
    // Desengancha el listener del socket viejo ANTES del logout: el close
    // resultante se procesaría async y, si llega después de que el usuario
    // dispare un nuevo init() (para pedir QR), el handler del socket viejo
    // ejecutaría clear() sobre la DB borrando las credenciales frescas
    // y haría sessions.delete(id) eliminando la nueva sesión del mapa.
    // Síntoma observado: "No se pudo vincular el dispositivo" al reintentar.
    try { s.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
    try {
        await s.sock.logout();
    } catch (e) {
        log.warn({ err: e, tenantId: id }, 'logout warning');
    }
    // Asegura cierre del WebSocket aunque logout haya fallado (no hay
    // handler ya, así que no reconecta).
    try { s.sock.end(new Error('logout')); } catch (_) {}
    try { await s.clear(); } catch (_) {}
    sessions.delete(id);
    const pool = await tenantResolver.getPool(id);
    await persistState(pool, { status: 'NOT_REGISTERED', last_error: null });
    return { ok: true, message: 'Sesión cerrada.' };
}

async function destroy(idEmpresa) {
    return disconnect(idEmpresa);
}

/**
 * Helper para enviar texto. jid: '521xxxxxxxxxx@s.whatsapp.net'
 *
 * Persistencia unificada (Fase 7):
 *   - En éxito registra el mensaje con status='sent' y emite
 *     'message:new' + 'conversation:updated' al room del tenant.
 *   - En error registra status='failed' con un wa_message_id local
 *     para que quede trazabilidad y re-lanza el error.
 *
 * Devuelve el payload persistido del mensaje (wa_message_id, ts, etc.).
 */
/**
 * Envía un mensaje de texto.
 *
 * @param {object} [opts]
 * @param {'human'|'api'|'ai'|'template'} [opts.via='api']
 * @param {number} [opts.sentByUser]  - id del usuario humano que envía desde
 *   el panel. Si está presente, dispara handoff automático: la conversación
 *   pasa a mode='human', ai_enabled=0, assigned_to=sentByUser. Es la
 *   implementación de "el empleado tomó la conversación" (Fase 8.3).
 */
async function sendText(idEmpresa, jid, body, opts = {}) {
    const id = parseInt(idEmpresa, 10);
    const via = opts.via || 'api';
    const sentByUser = opts.sentByUser || null;
    const s = sessions.get(id);
    if (!s || s.status !== 'READY') {
        const err = new Error(`Sesión de empresa ${id} no está READY (estado=${s?.status || 'NONE'}).`);
        try {
            const pool = await tenantResolver.getPool(id);
            await conversationStore.recordOutbound(pool, {
                jid,
                wa_message_id: `FAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                body,
                status: 'failed',
                ts: Math.floor(Date.now() / 1000),
                via,
            });
        } catch (_) { /* best-effort */ }
        throw err;
    }

    try {
        const sent = await s.sock.sendMessage(jid, { text: body });
        const wa_message_id = sent?.key?.id;
        const ts = Number(sent?.messageTimestamp) || Math.floor(Date.now() / 1000);
        const pool = await tenantResolver.getPool(id);
        const result = await conversationStore.recordOutbound(pool, {
            jid, wa_message_id, body, status: 'sent', ts, via,
        });
        if (result) {
            emit(id, 'message:new', { companyId: id, ...result.message, jid: result.jid });
            emit(id, 'conversation:updated', { companyId: id, ...result.conversation });
        }
        // Fase 8.3: handoff manual al humano. Si el envío vino de un usuario
        // del panel, etiquetamos el mensaje y silenciamos a la IA en esta
        // conversación hasta que un endpoint /release la devuelva al bot.
        if (sentByUser) {
            try {
                await conversationStore.tagSentByUser(pool, wa_message_id, sentByUser);
                await conversationStore.updateConversationFlags(pool, jid, {
                    mode: 'human',
                    aiEnabled: false,
                    assignedTo: sentByUser,
                });
                emit(id, 'conversation:handoff', {
                    companyId: id, jid, mode: 'human', assignedTo: sentByUser,
                });
            } catch (e) {
                log.error({ err: e, tenantId: id, jid }, 'handoff manual falló');
            }
        }
        return { wa_message_id, ts, jid, body, status: 'sent' };
    } catch (e) {
        try {
            const pool = await tenantResolver.getPool(id);
            await conversationStore.recordOutbound(pool, {
                jid,
                wa_message_id: `FAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                body,
                status: 'failed',
                ts: Math.floor(Date.now() / 1000),
                via,
            });
        } catch (_) { /* best-effort */ }
        throw e;
    }
}

/**
 * Envía un archivo multimedia (imagen o documento en MVP Fase B.1).
 *
 * @param {number|string} idEmpresa
 * @param {string} jid
 * @param {object} params
 * @param {'image'|'document'} params.type
 * @param {Buffer} params.buffer          - contenido del archivo
 * @param {string} params.mimeType        - MIME real del archivo
 * @param {string} [params.fileName]      - obligatorio para type='document'
 * @param {string} [params.caption]       - texto opcional (imagen)
 * @param {object} [opts]
 * @param {'human'|'api'|'template'} [opts.via='api']
 * @param {number} [opts.sentByUser]
 * @returns {Promise<{wa_message_id, ts, jid, type, status}>}
 */
async function sendMedia(idEmpresa, jid, params, opts = {}) {
    const id = parseInt(idEmpresa, 10);
    const via = opts.via || 'api';
    const sentByUser = opts.sentByUser || null;
    const { type, buffer, mimeType, fileName, caption, ptt, seconds } = params;

    if (!['image', 'document', 'audio', 'video'].includes(type)) {
        throw new Error(`sendMedia: tipo no soportado '${type}'`);
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
        throw new Error('sendMedia: buffer vacío o inválido');
    }
    if (buffer.length > mediaStore.MAX_SIZE_BYTES) {
        throw new Error(`sendMedia: excede ${mediaStore.MAX_SIZE_MB} MB`);
    }
    if (type === 'document' && !fileName) {
        throw new Error('sendMedia: fileName requerido para documentos');
    }

    const s = sessions.get(id);
    if (!s || s.status !== 'READY') {
        const err = new Error(`Sesión de empresa ${id} no está READY (estado=${s?.status || 'NONE'}).`);
        throw err;
    }

    // Construir el payload Baileys según el tipo
    let payload;
    if (type === 'image') {
        payload = { image: buffer, caption: caption || '', mimetype: mimeType };
    } else if (type === 'document') {
        payload = {
            document: buffer,
            mimetype: mimeType,
            fileName,
            caption: caption || '',
        };
    } else if (type === 'audio') {
        // ptt=true → aparece como nota de voz (micro) en WhatsApp
        payload = {
            audio: buffer,
            mimetype: mimeType,
            ptt: !!ptt,
        };
        if (seconds) payload.seconds = Number(seconds);
    } else {
        // video
        payload = {
            video: buffer,
            mimetype: mimeType,
            caption: caption || '',
        };
        if (fileName) payload.fileName = fileName;
    }

    try {
        const sent = await s.sock.sendMessage(jid, payload);
        const wa_message_id = sent?.key?.id;
        const ts = Number(sent?.messageTimestamp) || Math.floor(Date.now() / 1000);

        // Persistir el binario en nuestro storage para poder re-servirlo desde el panel
        let savedRelative = null;
        try {
            const saved = mediaStore.saveBuffer({
                companyId: id,
                waMessageId: wa_message_id,
                buffer,
                mimeType,
                ts,
            });
            savedRelative = saved.relativePath;
        } catch (e) {
            log.warn({ err: e, tenantId: id, wa_message_id }, 'saveBuffer outgoing falló');
        }

        // body en DB: documento→filename, audio PTT→null (nota de voz sin texto),
        // resto (image/video/audio-archivo)→caption si hay.
        let bodyForDb;
        if (type === 'document') bodyForDb = fileName;
        else if (type === 'audio' && ptt) bodyForDb = null;
        else bodyForDb = caption || null;
        const pool = await tenantResolver.getPool(id);
        const result = await conversationStore.recordOutbound(pool, {
            jid,
            wa_message_id,
            body: bodyForDb,
            type,
            status: 'sent',
            ts,
            via,
            media_url: savedRelative,
            media_mime: mimeType,
        });
        if (result) {
            emit(id, 'message:new', { companyId: id, ...result.message, jid: result.jid });
            emit(id, 'conversation:updated', { companyId: id, ...result.conversation });
        }

        if (sentByUser) {
            try {
                await conversationStore.tagSentByUser(pool, wa_message_id, sentByUser);
                await conversationStore.updateConversationFlags(pool, jid, {
                    mode: 'human',
                    aiEnabled: false,
                    assignedTo: sentByUser,
                });
                emit(id, 'conversation:handoff', {
                    companyId: id, jid, mode: 'human', assignedTo: sentByUser,
                });
            } catch (e) {
                log.error({ err: e, tenantId: id, jid }, 'handoff manual (media) falló');
            }
        }

        return { wa_message_id, ts, jid, type, status: 'sent' };
    } catch (e) {
        try {
            const pool = await tenantResolver.getPool(id);
            await conversationStore.recordOutbound(pool, {
                jid,
                wa_message_id: `FAIL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                body: type === 'document' ? fileName : (caption || `[${type}]`),
                type,
                status: 'failed',
                ts: Math.floor(Date.now() / 1000),
                via,
            });
        } catch (_) { /* best-effort */ }
        throw e;
    }
}

/**
 * Graceful shutdown (Fase 9.3). Cierra todas las sesiones Baileys en
 * paralelo con un timeout corto por sesión, para que PM2/systemd no tenga
 * que mandar SIGKILL. Idempotente.
 */
async function shutdown({ timeoutMs = 5000 } = {}) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    const entries = [...sessions.entries()];
    log.info({ count: entries.length }, 'waManager: shutdown iniciado');

    const closeOne = async ([id, s]) => {
        try {
            if (s?.sock) {
                const p = new Promise((resolve) => {
                    try { s.sock.ev.removeAllListeners('connection.update'); } catch (_) {}
                    try { s.sock.end(undefined); } catch (_) {}
                    resolve();
                });
                await Promise.race([
                    p,
                    new Promise((r) => setTimeout(r, timeoutMs)),
                ]);
            }
            log.info({ tenantId: id }, 'sesión cerrada');
        } catch (e) {
            log.warn({ err: e, tenantId: id }, 'error cerrando sesión');
        }
    };

    await Promise.all(entries.map(closeOne));
    sessions.clear();
    log.info('waManager: shutdown completado');
}

/**
 * Lista resumida para /connected-clients.
 */
function listSessions() {
    return [...sessions.entries()].map(([id, s]) => ({
        company_id: id,
        whatsapp_ready: s.status === 'READY',
        status_detail: s.status,
        error_message: s.lastError,
        phoneNumber: s.info?.id?.split(':')[0] || null,
        pushname: s.info?.name || null,
    }));
}

module.exports = {
    setIo,
    init,
    getSession,
    getSessionInfo,
    getStatus,
    restart,
    disconnect,
    destroy,
    sendText,
    sendMedia,
    listSessions,
    shutdown,
    _state: { sessions },
    // Hooks sólo para tests de integración (Fase 9.5). NO usar en runtime.
    _test: {
        maybeAutoReply,
        setSession(idEmpresa, partial) {
            const id = parseInt(idEmpresa, 10);
            const existing = sessions.get(id) || {};
            sessions.set(id, { ...existing, ...partial });
        },
        deleteSession(idEmpresa) {
            sessions.delete(parseInt(idEmpresa, 10));
        },
        resetShutdownFlag() {
            _shuttingDown = false;
        },
    },
};

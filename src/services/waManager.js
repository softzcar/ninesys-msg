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

    const session = {
        sock,
        clear,
        status: 'INITIALIZING',
        qr: null,
        lastError: null,
        info: null,
        pausedUntil: null,
    };
    sessions.set(id, session);
    await persistState(pool, { status: 'INITIALIZING', last_error: null });
    emit(id, 'status', { status: 'INITIALIZING', message: 'Inicializando cliente...' });

    sock.ev.on('creds.update', saveCreds);

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
                console.error(`[waManager:${id}] Error generando QR base64:`, e);
            }
        }

        if (connection === 'open') {
            session.status = 'READY';
            session.qr = null;
            session.info = sock.user || null;
            session.lastError = null;
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
            session.status = 'DISCONNECTED';
            session.lastError = lastDisconnect?.error?.message || null;
            await persistState(pool, {
                status: 'DISCONNECTED',
                last_error: session.lastError,
            });
            emit(id, 'disconnected', { reason });

            // Re-conectar excepto si fue logout explícito
            if (code !== DisconnectReason.loggedOut) {
                console.log(`[waManager:${id}] Reconectando (motivo=${reason})...`);
                setTimeout(() => init(id).catch((e) => {
                    console.error(`[waManager:${id}] Reconexión falló:`, e.message);
                    emit(id, 'error', { message: e.message });
                }), 1500);
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
        try { s.sock.end(new Error('restart')); } catch (_) {}
    }
    sessions.delete(id);
    return init(id);
}

async function disconnect(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const s = sessions.get(id);
    if (!s) return { ok: true, message: 'No había sesión activa.' };
    try {
        await s.sock.logout();
    } catch (e) {
        console.warn(`[waManager:${id}] logout warning:`, e.message);
    }
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
 */
async function sendText(idEmpresa, jid, body) {
    const id = parseInt(idEmpresa, 10);
    const s = sessions.get(id);
    if (!s || s.status !== 'READY') {
        throw new Error(`Sesión de empresa ${id} no está READY (estado=${s?.status || 'NONE'}).`);
    }
    return s.sock.sendMessage(jid, { text: body });
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
    listSessions,
};

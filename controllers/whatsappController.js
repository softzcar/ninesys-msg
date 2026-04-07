/**
 * whatsappController.js
 *
 * Controlador único de WhatsApp para msg_ninesys, respaldado por Baileys
 * multi-tenant (src/services/waManager.js) con persistencia MySQL en cada
 * api_emp_{id_empresa}.
 *
 * Mantiene la misma firma que el controlador legacy (whatsapp-web.js +
 * Puppeteer) que existía antes de Fase 5, para no romper el contrato HTTP/WS
 * congelado en docs/API_CONTRACT.md y consumido por app_multi.
 */

const loadTemplates = require('../templates/templates-loader');
const waManager = require('../src/services/waManager');
const tenantResolver = require('../src/db/tenantResolver');
const conversationStore = require('../src/services/conversationStore');

let templates = {};
try {
    templates = loadTemplates();
    console.log(`[whatsappController] Templates cargados: ${Object.keys(templates).join(', ')}`);
} catch (e) {
    console.warn('[whatsappController] No se pudieron cargar templates:', e.message);
}

/**
 * Convierte "521xxxxxxxxxx" → "521xxxxxxxxxx@s.whatsapp.net"
 * Acepta números con +, espacios o guiones.
 */
function toJid(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) throw new Error('Número de teléfono inválido');
    return `${digits}@s.whatsapp.net`;
}

// ---------------------------------------------------------------------------
// Funciones de bajo nivel (usadas por websocket.js)
// ---------------------------------------------------------------------------

function getClientStatus(companyId) {
    const status = waManager.getStatus(companyId);
    // Si no hay sesión en memoria, dispararla en background. La próxima
    // llamada (o el subscribe de Socket.IO) verá el estado actualizado.
    if (status.status === 'NOT_REGISTERED') {
        waManager.init(companyId).catch((e) => {
            console.error(`[whatsappController] init lazy de ${companyId} falló:`, e.message);
        });
        return { ...status, status: 'INITIALIZING', message: 'Reanudando sesión...' };
    }
    return status;
}

async function initializeClient(companyId) {
    return waManager.init(companyId);
}

async function restartClient(companyId) {
    return waManager.restart(companyId);
}

async function disconnectClient(companyId) {
    return waManager.disconnect(companyId);
}

/**
 * En Baileys no precargamos sesiones al boot: cada empresa se inicializa
 * lazy en el primer subscribe / session-info. Mantener la firma para que
 * app.js no cambie.
 */
async function initializeAllClientsFromSessions() {
    console.log('[whatsappController] Las sesiones se inician lazy bajo demanda.');
    return;
}

// ---------------------------------------------------------------------------
// Handlers HTTP (Express)
// ---------------------------------------------------------------------------

async function getSessionInfo(companyId) {
    // Mismo contrato que el legacy: retorna objeto, NO usa res
    return waManager.getSessionInfo(companyId);
}

async function showQRCode(req, res) {
    const { companyId } = req.params;
    try {
        const info = await waManager.getSessionInfo(companyId);
        if (info.qr) {
            return res.send(
                `<html><body style="background:#222;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
                    <img src="${info.qr}" style="max-width:90vw;max-height:90vh"/>
                </body></html>`
            );
        }
        res.status(404).send('QR no disponible (cliente conectado o estado inválido)');
    } catch (e) {
        res.status(500).send(`Error: ${e.message}`);
    }
}

function showQRCodeBasic(companyId) {
    const s = waManager.getSession(companyId);
    if (s && s.qr) return s.qr;
    return 'Cliente conectado. QR no disponible.';
}

async function getConnectedClients(req, res) {
    try {
        res.status(200).json(waManager.listSessions());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

async function getChatsByCompanyId(req, res) {
    const { companyId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
        const chats = await conversationStore.listConversations(pool, { limit });
        res.status(200).json(chats);
    } catch (e) {
        console.error(`[whatsappController] getChats(${companyId}) falló:`, e.message);
        res.status(500).json({ message: 'Error obteniendo conversaciones', error: e.message });
    }
}

// ----- Endpoints aditivos Fase 6 (no rompen el contrato congelado) -----

async function getConversationMessages(req, res) {
    const { companyId, jid } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const before = req.query.before ? Number(req.query.before) : null;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const messages = await conversationStore.listMessages(pool, jid, { before, limit });
        res.status(200).json({ jid, messages });
    } catch (e) {
        console.error(`[whatsappController] getMessages(${companyId},${jid}) falló:`, e.message);
        res.status(500).json({ message: 'Error obteniendo mensajes', error: e.message });
    }
}

async function markConversationRead(req, res) {
    const { companyId, jid } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        await conversationStore.markRead(pool, jid);
        res.status(200).json({ jid, unread_count: 0 });
    } catch (e) {
        console.error(`[whatsappController] markRead(${companyId},${jid}) falló:`, e.message);
        res.status(500).json({ message: 'Error marcando como leído', error: e.message });
    }
}

async function restartClientByCompanyId(req, res) {
    const { companyId } = req.params;
    try {
        await waManager.restart(companyId);
        res.status(200).json({ message: `Cliente ${companyId} reiniciado.` });
    } catch (e) {
        res.status(500).json({ message: 'Error reiniciando cliente', error: e.message });
    }
}

async function disconnectClientByCompanyId(req, res) {
    const { companyId } = req.params;
    try {
        const result = await waManager.disconnect(companyId);
        res.status(200).json({ message: result.message });
    } catch (e) {
        res.status(500).json({ message: 'Error desconectando cliente', error: e.message });
    }
}

async function deleteClientByCompanyId(req, res) {
    const { companyId } = req.params;
    try {
        await waManager.destroy(companyId);
        res.status(200).json({ message: `Cliente ${companyId} eliminado.` });
    } catch (e) {
        res.status(500).json({ message: 'Error eliminando cliente', error: e.message });
    }
}

// ----- Envío de mensajes -----

async function sendMessage(req, res) {
    // /send-message-basic/:companyId  → antepone "Hola <name>, "
    const { companyId } = req.params;
    const { phone, name, message } = req.body || {};
    if (!phone || !message) {
        return res.status(400).json({ message: 'phone y message son requeridos' });
    }
    try {
        const body = `Hola ${name || ''}, ${message}`.trim();
        await waManager.sendText(companyId, toJid(phone), body);
        res.status(200).json({ success: true, message: 'Mensaje enviado' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

async function sendMessageCustom(req, res) {
    const { companyId } = req.params;
    const { phone, message } = req.body || {};
    if (!phone || !message) {
        return res.status(400).json({ message: 'phone y message son requeridos' });
    }
    try {
        await waManager.sendText(companyId, toJid(phone), message);
        res.status(200).json({ success: true, message: 'Mensaje enviado' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

async function sendTemplateMessage(req, res) {
    const { companyId } = req.params;
    const { phone_client, template, ...vars } = req.body || {};
    if (!phone_client || !template) {
        return res.status(400).json({ message: 'phone_client y template son requeridos' });
    }
    const tpl = templates[template];
    if (typeof tpl !== 'function') {
        return res.status(404).json({ message: `Template '${template}' no encontrado` });
    }
    try {
        const body = tpl({ ...vars, phone: phone_client });
        await waManager.sendText(companyId, toJid(phone_client), body);
        res.status(200).json({ success: true, message: 'Mensaje enviado' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

async function sendDirectMessage(req, res) {
    const { companyId } = req.params;
    const { phone, message } = req.body || {};
    if (!phone || !message) {
        return res.status(400).json({ success: false, message: 'phone y message son requeridos' });
    }
    // fire-and-forget como el legacy
    waManager.sendText(companyId, toJid(phone), message).catch((e) => {
        console.error(`[whatsappController] sendDirectMessage falló para ${companyId}:`, e.message);
    });
    res.status(200).json({ success: true, message: 'Solicitud aceptada' });
}

module.exports = {
    // Bajo nivel
    getClientStatus,
    initializeClient,
    restartClient,
    disconnectClient,
    initializeAllClientsFromSessions,
    // HTTP
    getSessionInfo,
    showQRCode,
    showQRCodeBasic,
    getConnectedClients,
    getChatsByCompanyId,
    restartClientByCompanyId,
    disconnectClientByCompanyId,
    deleteClientByCompanyId,
    sendMessage,
    sendMessageCustom,
    sendTemplateMessage,
    sendDirectMessage,
    // Fase 6
    getConversationMessages,
    markConversationRead,
};

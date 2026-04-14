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

const fs = require('fs');
const loadTemplates = require('../templates/templates-loader');
const waManager = require('../src/services/waManager');
const tenantResolver = require('../src/db/tenantResolver');
const conversationStore = require('../src/services/conversationStore');
const mediaStore = require('../src/services/mediaStore');
const aiService = require('../src/services/aiService');
const log = require('../src/lib/logger').createLogger('whatsappController');

let templates = {};
try {
    templates = loadTemplates();
    log.info({ templates: Object.keys(templates) }, 'Templates cargados');
} catch (e) {
    log.warn({ err: e }, 'No se pudieron cargar templates');
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
            log.error({ err: e, tenantId: companyId }, 'init lazy falló');
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
    log.info('Las sesiones se inician lazy bajo demanda');
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
        log.error({ err: e, tenantId: companyId }, 'getChats falló');
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
        log.error({ err: e, tenantId: companyId, jid }, 'getMessages falló');
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
        log.error({ err: e, tenantId: companyId, jid }, 'markRead falló');
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
        const sent = await waManager.sendText(companyId, toJid(phone), body);
        res.status(200).json({ success: true, message: 'Mensaje enviado', data: sent });
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
        const sent = await waManager.sendText(companyId, toJid(phone), message);
        res.status(200).json({ success: true, message: 'Mensaje enviado', data: sent });
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
        const sent = await waManager.sendText(companyId, toJid(phone_client), body);
        res.status(200).json({ success: true, message: 'Mensaje enviado', data: sent });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
}

async function sendDirectMessage(req, res) {
    const { companyId } = req.params;
    const { phone, jid: rawJid, message, sent_by_user } = req.body || {};
    if (!message || (!phone && !rawJid)) {
        return res.status(400).json({
            success: false,
            message: 'message y (phone o jid) son requeridos',
        });
    }
    try {
        // Si el caller pasa jid directamente (p.ej. el inbox del panel), lo
        // usamos tal cual para no romper el formato original que Baileys
        // necesita (puede ser @s.whatsapp.net, @lid, @g.us, etc.). Sólo si
        // no hay jid reconstruimos a partir del teléfono (flujo legacy).
        const targetJid = rawJid && typeof rawJid === 'string' && rawJid.includes('@')
            ? rawJid
            : toJid(phone);

        // Si el caller indica un usuario humano (panel), se reenvía como
        // via='human' + sentByUser → dispara handoff manual en waManager.
        const opts = sent_by_user
            ? { via: 'human', sentByUser: Number(sent_by_user) }
            : {};
        log.info({ tenantId: companyId, jid: targetJid, via: opts.via || 'api' }, 'sendDirectMessage');
        const sent = await waManager.sendText(companyId, targetJid, message, opts);
        res.status(200).json({ success: true, message: 'Mensaje enviado', data: sent });
    } catch (e) {
        log.error({ err: e, tenantId: companyId }, 'sendDirectMessage falló');
        res.status(500).json({ success: false, message: e.message });
    }
}

// ---------------------------------------------------------------------------
// Fase A — CRUD de Agentes IA
// ---------------------------------------------------------------------------

async function listAiAgents(req, res) {
    const { companyId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const agents = await aiService.listAgents(pool);
        res.status(200).json(agents);
    } catch (e) {
        log.error({ err: e, tenantId: companyId }, 'listAiAgents falló');
        res.status(500).json({ message: 'Error listando agentes IA', error: e.message });
    }
}

async function getAiAgent(req, res) {
    const { companyId, agentId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const agent = await aiService.loadAgent(pool, Number(agentId));
        if (!agent) return res.status(404).json({ message: 'Agente no encontrado' });
        res.status(200).json(agent);
    } catch (e) {
        log.error({ err: e, tenantId: companyId }, 'getAiAgent falló');
        res.status(500).json({ message: 'Error obteniendo agente', error: e.message });
    }
}

async function createAiAgent(req, res) {
    const { companyId } = req.params;
    const { name, slug, systemPrompt, knowledgeBase, model, temperature, maxTokens, enabled, isDefault } = req.body || {};
    if (!name || !slug) {
        return res.status(400).json({ message: 'name y slug son requeridos' });
    }
    if (!/^[a-z0-9_-]+$/.test(slug)) {
        return res.status(400).json({ message: 'slug debe contener solo letras minúsculas, números, guiones y guiones bajos' });
    }
    try {
        const pool = await tenantResolver.getPool(companyId);
        const agent = await aiService.createAgent(pool, {
            name, slug, systemPrompt, knowledgeBase, model, temperature, maxTokens, enabled, isDefault,
        });
        res.status(201).json(agent);
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: `El slug '${slug}' ya existe` });
        }
        log.error({ err: e, tenantId: companyId }, 'createAiAgent falló');
        res.status(500).json({ message: 'Error creando agente', error: e.message });
    }
}

async function updateAiAgent(req, res) {
    const { companyId, agentId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const agent = await aiService.updateAgent(pool, Number(agentId), req.body || {});
        if (!agent) return res.status(404).json({ message: 'Agente no encontrado o sin cambios' });
        res.status(200).json(agent);
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'El slug ya está en uso por otro agente' });
        }
        log.error({ err: e, tenantId: companyId }, 'updateAiAgent falló');
        res.status(500).json({ message: 'Error actualizando agente', error: e.message });
    }
}

async function deleteAiAgent(req, res) {
    const { companyId, agentId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const deleted = await aiService.deleteAgent(pool, Number(agentId));
        if (!deleted) return res.status(404).json({ message: 'Agente no encontrado' });
        res.status(200).json({ message: 'Agente eliminado', agentId: Number(agentId) });
    } catch (e) {
        log.error({ err: e, tenantId: companyId }, 'deleteAiAgent falló');
        res.status(500).json({ message: 'Error eliminando agente', error: e.message });
    }
}

async function assignAgentToConversation(req, res) {
    const { companyId, jid } = req.params;
    const { agentId } = req.body || {};
    // agentId null = desvincular (volver al default)
    try {
        const pool = await tenantResolver.getPool(companyId);
        if (agentId) {
            const agent = await aiService.loadAgent(pool, Number(agentId));
            if (!agent) return res.status(404).json({ message: 'Agente no encontrado' });
        }
        const ok = await conversationStore.updateConversationFlags(pool, jid, {
            aiAgentId: agentId ? Number(agentId) : null,
        });
        if (!ok) return res.status(404).json({ message: 'Conversación no encontrada' });
        res.status(200).json({ jid, aiAgentId: agentId ? Number(agentId) : null });
    } catch (e) {
        log.error({ err: e, tenantId: companyId, jid }, 'assignAgent falló');
        res.status(500).json({ message: 'Error asignando agente', error: e.message });
    }
}

// ---------------------------------------------------------------------------
// Fase 8 — Endpoints de control IA
// ---------------------------------------------------------------------------

const VALID_MODES = new Set(['bot', 'human', 'hybrid']);

async function getAiSettings(req, res) {
    const { companyId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const settings = await aiService.loadSettings(pool);
        if (!settings) return res.status(404).json({ message: 'wa_ai_settings no inicializada' });
        res.status(200).json(settings);
    } catch (e) {
        res.status(500).json({ message: 'Error leyendo settings IA', error: e.message });
    }
}

async function updateAiSettings(req, res) {
    const { companyId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        await aiService.updateSettings(pool, req.body || {});
        const settings = await aiService.loadSettings(pool);
        res.status(200).json(settings);
    } catch (e) {
        res.status(500).json({ message: 'Error actualizando settings IA', error: e.message });
    }
}

async function toggleAiGlobal(req, res) {
    const { companyId } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'Body requiere { enabled: boolean }' });
    }
    try {
        const pool = await tenantResolver.getPool(companyId);
        await aiService.setGlobalEnabled(pool, enabled);
        res.status(200).json({ companyId: Number(companyId), enabled });
    } catch (e) {
        res.status(500).json({ message: 'Error toggling IA global', error: e.message });
    }
}

async function toggleAiConversation(req, res) {
    const { companyId, jid } = req.params;
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ message: 'Body requiere { enabled: boolean }' });
    }
    try {
        const pool = await tenantResolver.getPool(companyId);
        const ok = await conversationStore.updateConversationFlags(pool, jid, { aiEnabled: enabled });
        if (!ok) return res.status(404).json({ message: 'Conversación no encontrada' });
        res.status(200).json({ jid, aiEnabled: enabled });
    } catch (e) {
        res.status(500).json({ message: 'Error toggling IA por conversación', error: e.message });
    }
}

async function setConversationMode(req, res) {
    const { companyId, jid } = req.params;
    const { mode } = req.body || {};
    if (!VALID_MODES.has(mode)) {
        return res.status(400).json({ message: `mode debe ser uno de: ${[...VALID_MODES].join(', ')}` });
    }
    try {
        const pool = await tenantResolver.getPool(companyId);
        const ok = await conversationStore.updateConversationFlags(pool, jid, { mode });
        if (!ok) return res.status(404).json({ message: 'Conversación no encontrada' });
        res.status(200).json({ jid, mode });
    } catch (e) {
        res.status(500).json({ message: 'Error cambiando modo', error: e.message });
    }
}

async function assignConversation(req, res) {
    const { companyId, jid } = req.params;
    const { userId } = req.body || {};
    if (!userId || isNaN(Number(userId))) {
        return res.status(400).json({ message: 'Body requiere { userId: number }' });
    }
    try {
        const pool = await tenantResolver.getPool(companyId);
        const ok = await conversationStore.updateConversationFlags(pool, jid, {
            assignedTo: Number(userId),
            mode: 'human',
            aiEnabled: false,
        });
        if (!ok) return res.status(404).json({ message: 'Conversación no encontrada' });
        res.status(200).json({ jid, assignedTo: Number(userId), mode: 'human', aiEnabled: false });
    } catch (e) {
        res.status(500).json({ message: 'Error asignando conversación', error: e.message });
    }
}

async function releaseConversation(req, res) {
    // Devuelve la conversación al bot: hybrid + ai_enabled=1 + sin asignar.
    const { companyId, jid } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const ok = await conversationStore.updateConversationFlags(pool, jid, {
            mode: 'hybrid',
            aiEnabled: true,
            assignedTo: null,
        });
        if (!ok) return res.status(404).json({ message: 'Conversación no encontrada' });
        res.status(200).json({ jid, mode: 'hybrid', aiEnabled: true, assignedTo: null });
    } catch (e) {
        res.status(500).json({ message: 'Error liberando conversación', error: e.message });
    }
}

// ---------------------------------------------------------------------------
// Fase B.1 — Media (servir y enviar archivos multimedia)
// ---------------------------------------------------------------------------

/**
 * GET /media/:companyId/:waMessageId
 * Sirve el archivo multimedia asociado a un mensaje. Busca en BD el path
 * relativo y lo resuelve contra mediaStore. Aplica auth (se monta en routes
 * bajo authenticateToken).
 */
async function getMedia(req, res) {
    const { companyId, waMessageId } = req.params;
    try {
        const pool = await tenantResolver.getPool(companyId);
        const row = await conversationStore.getMediaByMessageId(pool, waMessageId);
        if (!row || !row.media_url) {
            return res.status(404).json({ message: 'Archivo no encontrado' });
        }
        const abs = mediaStore.resolveRelative(row.media_url);
        if (!abs || !fs.existsSync(abs)) {
            return res.status(404).json({ message: 'Archivo no disponible en storage' });
        }
        res.setHeader('Content-Type', row.media_mime || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        // Para documentos, forzar descarga con el nombre original (body)
        if (row.type === 'document' && row.body) {
            const safeName = String(row.body).replace(/"/g, '');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
        }
        fs.createReadStream(abs).pipe(res);
    } catch (e) {
        log.error({ err: e, tenantId: companyId, waMessageId }, 'getMedia falló');
        res.status(500).json({ message: 'Error al servir archivo', error: e.message });
    }
}

/**
 * POST /send-media/:companyId  (multipart/form-data)
 * Campos:
 *   - file  : el archivo (requerido, max MEDIA_MAX_SIZE_MB)
 *   - phone : número destino (requerido)
 *   - type  : 'image' | 'document' (requerido)
 *   - caption: texto opcional (ignorado si type=document, ahí usa fileName)
 *   - sentByUser: id del usuario del panel (para handoff)
 */
async function uploadAndSendMedia(req, res) {
    const { companyId } = req.params;
    const { phone, jid: rawJid, type, caption, sentByUser } = req.body || {};
    const file = req.file;

    if (!file) return res.status(400).json({ message: 'Archivo requerido (campo "file")' });
    if (!phone && !rawJid) return res.status(400).json({ message: 'phone o jid requerido' });
    if (!['image', 'document'].includes(type)) {
        return res.status(400).json({ message: `type debe ser 'image' o 'document'` });
    }

    try {
        // Preferimos el jid crudo (respeta @lid/@s.whatsapp.net/@g.us) y sólo
        // reconstruimos desde phone si no vino jid, mismo criterio que
        // sendDirectMessage.
        const jid = rawJid && typeof rawJid === 'string' && rawJid.includes('@')
            ? rawJid
            : toJid(phone);
        const result = await waManager.sendMedia(companyId, jid, {
            type,
            buffer: file.buffer,
            mimeType: file.mimetype,
            fileName: file.originalname,
            caption: caption || '',
        }, {
            via: sentByUser ? 'human' : 'api',
            sentByUser: sentByUser ? Number(sentByUser) : undefined,
        });
        res.status(200).json(result);
    } catch (e) {
        log.error({ err: e, tenantId: companyId, type }, 'uploadAndSendMedia falló');
        const code = /READY|buffer|límite|excede/i.test(e.message) ? 400 : 500;
        res.status(code).json({ message: e.message });
    }
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
    // Fase 8
    getAiSettings,
    updateAiSettings,
    toggleAiGlobal,
    toggleAiConversation,
    setConversationMode,
    assignConversation,
    releaseConversation,
    // Fase A — Agentes IA
    listAiAgents,
    getAiAgent,
    createAiAgent,
    updateAiAgent,
    deleteAiAgent,
    assignAgentToConversation,
    // Fase B.1 — Media
    getMedia,
    uploadAndSendMedia,
};

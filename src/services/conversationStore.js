/**
 * conversationStore.js
 *
 * Capa de persistencia para conversaciones y mensajes WhatsApp en cada
 * tenant (api_emp_{id_empresa}). Trabaja sobre las tablas creadas en
 * db/migrations/001_wa_tables.sql:
 *   - wa_conversations
 *   - wa_messages
 *
 * Las funciones reciben el `pool` mysql2 ya resuelto por tenantResolver,
 * de modo que este módulo no sabe nada de multi-tenancy.
 *
 * Mensajes Baileys → schema:
 *   wa_message_id ← key.id
 *   jid           ← key.remoteJid
 *   from_me       ← key.fromMe
 *   sender        ← key.participant || key.remoteJid
 *   ts            ← messageTimestamp (segundos)
 *   type          ← extractType()
 *   body          ← extractBody()
 *   status        ← 'delivered' por defecto en upsert; updates llegan por messages.update
 */

/**
 * Extrae el tipo principal del mensaje Baileys.
 */
function extractType(msg) {
    if (!msg) return 'system';
    if (msg.conversation || msg.extendedTextMessage) return 'text';
    if (msg.imageMessage) return 'image';
    if (msg.audioMessage) return 'audio';
    if (msg.videoMessage) return 'video';
    if (msg.documentMessage) return 'document';
    if (msg.stickerMessage) return 'sticker';
    if (msg.locationMessage) return 'location';
    if (msg.contactMessage || msg.contactsArrayMessage) return 'contact';
    return 'system';
}

/**
 * Extrae el body textual visible de un mensaje Baileys.
 */
function extractBody(msg) {
    if (!msg) return null;
    if (msg.conversation) return msg.conversation;
    if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
    if (msg.imageMessage?.caption) return msg.imageMessage.caption;
    if (msg.videoMessage?.caption) return msg.videoMessage.caption;
    if (msg.documentMessage?.fileName) return `[archivo] ${msg.documentMessage.fileName}`;
    if (msg.audioMessage) return '[audio]';
    if (msg.stickerMessage) return '[sticker]';
    if (msg.locationMessage) return '[ubicación]';
    if (msg.contactMessage) return `[contacto] ${msg.contactMessage.displayName || ''}`;
    return null;
}

/**
 * Upsert de un mensaje Baileys + actualización de la conversación.
 * Devuelve { jid, conversation, message } para que el caller pueda emitir
 * eventos al frontend.
 *
 * @param {Pool} pool
 * @param {object} m  - mensaje Baileys (proto.IWebMessageInfo)
 */
async function ingestMessage(pool, m) {
    const jid = m.key?.remoteJid;
    if (!jid) return null;

    const wa_message_id = m.key.id;
    const from_me = m.key.fromMe ? 1 : 0;
    const sender = m.key.participant || m.key.remoteJid;
    const ts = Number(m.messageTimestamp) || Math.floor(Date.now() / 1000);
    const type = extractType(m.message);
    const body = extractBody(m.message);
    const isGroup = jid.endsWith('@g.us') ? 1 : 0;
    const pushname = m.pushName || null;

    // 1) Insert mensaje (idempotente por wa_message_id). Si ya existía
    //    (p.ej. persistido por recordOutbound antes del upsert), salimos
    //    sin emitir nada para evitar eventos duplicados.
    const [ins] = await pool.query(
        `INSERT IGNORE INTO wa_messages
            (jid, wa_message_id, from_me, sender, type, body, via, status, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jid, wa_message_id, from_me, sender, type, body, from_me ? 'api' : 'human', 'delivered', ts]
    );
    if (ins.affectedRows === 0) return null;

    // 2) Upsert conversación + bump last_*
    const lastPreview = (body || `[${type}]`).slice(0, 500);
    await pool.query(
        `INSERT INTO wa_conversations (jid, name, is_group, last_message, last_ts, unread_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            name         = COALESCE(VALUES(name), name),
            last_message = VALUES(last_message),
            last_ts      = VALUES(last_ts),
            unread_count = unread_count + VALUES(unread_count),
            updated_at   = CURRENT_TIMESTAMP`,
        [jid, pushname, isGroup, lastPreview, ts, from_me ? 0 : 1]
    );

    return {
        jid,
        message: { wa_message_id, from_me: !!from_me, sender, type, body, ts, status: 'delivered' },
        conversation: { jid, last_message: lastPreview, last_ts: ts, unread_delta: from_me ? 0 : 1 },
    };
}

/**
 * Persistencia explícita de un mensaje saliente (enviado vía API).
 * Se usa desde waManager.sendText para:
 *   - registrar el mensaje de inmediato con el wa_message_id real
 *   - permitir marcar 'failed' cuando Baileys revienta
 *   - evitar el roundtrip del listener messages.upsert antes de emitir
 *
 * Idempotente: si el wa_message_id ya existe actualiza status/body.
 * Devuelve { jid, message, conversation } o null si el jid es inválido.
 */
async function recordOutbound(pool, { jid, wa_message_id, body, type = 'text', status = 'sent', ts, via = 'api' }) {
    if (!jid || !wa_message_id) return null;
    const timestamp = Number(ts) || Math.floor(Date.now() / 1000);
    const isGroup = jid.endsWith('@g.us') ? 1 : 0;

    await pool.query(
        `INSERT INTO wa_messages
            (jid, wa_message_id, from_me, sender, type, body, via, status, ts)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            body   = COALESCE(VALUES(body), body)`,
        [jid, wa_message_id, jid, type, body, via, status, timestamp]
    );

    const lastPreview = (body || `[${type}]`).slice(0, 500);
    await pool.query(
        `INSERT INTO wa_conversations (jid, is_group, last_message, last_ts, unread_count)
         VALUES (?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
            last_message = VALUES(last_message),
            last_ts      = VALUES(last_ts),
            updated_at   = CURRENT_TIMESTAMP`,
        [jid, isGroup, lastPreview, timestamp]
    );

    return {
        jid,
        message: { wa_message_id, from_me: true, sender: jid, type, body, ts: timestamp, status, via },
        conversation: { jid, last_message: lastPreview, last_ts: timestamp, unread_delta: 0 },
    };
}

/**
 * Actualiza el status de un mensaje (sent/delivered/read/failed).
 */
async function updateMessageStatus(pool, wa_message_id, status) {
    if (!wa_message_id || !status) return;
    await pool.query(
        `UPDATE wa_messages SET status = ? WHERE wa_message_id = ?`,
        [status, wa_message_id]
    );
}

/**
 * Lista las conversaciones más recientes de un tenant.
 */
async function listConversations(pool, { limit = 100 } = {}) {
    const [rows] = await pool.query(
        `SELECT c.id, c.jid, c.name, c.is_group, c.mode, c.ai_enabled, c.assigned_to,
                c.ai_agent_id, c.unread_count, c.last_message, c.last_ts, c.tags,
                c.created_at, c.updated_at, a.name AS agent_name
         FROM wa_conversations c
         LEFT JOIN wa_ai_agents a ON a.id = c.ai_agent_id
         ORDER BY c.last_ts DESC
         LIMIT ?`,
        [limit]
    );
    // Mapear al shape que esperaba el legacy /chats/:companyId
    return rows.map((r) => ({
        id: r.jid,
        name: r.name,
        isGroup: !!r.is_group,
        unreadCount: r.unread_count,
        lastMessage: r.last_message,
        timestamp: r.last_ts,
        // extras nuevos (aditivos, no rompen el contrato)
        mode: r.mode,
        aiEnabled: !!r.ai_enabled,
        assignedTo: r.assigned_to,
        aiAgentId: r.ai_agent_id || null,
        agentName: r.agent_name || null,
    }));
}

/**
 * Mensajes de una conversación, paginado por timestamp descendente.
 */
async function listMessages(pool, jid, { before = null, limit = 50 } = {}) {
    const params = [jid];
    let where = 'jid = ?';
    if (before) {
        where += ' AND ts < ?';
        params.push(Number(before));
    }
    params.push(Number(limit));
    const [rows] = await pool.query(
        `SELECT id, wa_message_id, from_me, sender, type, body, media_url, media_mime,
                via, status, ts, created_at
         FROM wa_messages
         WHERE ${where}
         ORDER BY ts DESC
         LIMIT ?`,
        params
    );
    return rows.map((r) => ({
        id: r.id,
        wa_message_id: r.wa_message_id,
        from_me: !!r.from_me,
        sender: r.sender,
        type: r.type,
        body: r.body,
        media_url: r.media_url,
        media_mime: r.media_mime,
        via: r.via,
        status: r.status,
        ts: Number(r.ts),
    }));
}

/**
 * Lee los flags de una conversación necesarios para decidir si la IA debe
 * auto-responder (Fase 8). Devuelve null si la conversación no existe.
 */
async function getConversationFlags(pool, jid) {
    const [rows] = await pool.query(
        `SELECT jid, is_group, mode, ai_enabled, assigned_to, ai_agent_id
         FROM wa_conversations WHERE jid = ?`,
        [jid]
    );
    const r = rows[0];
    if (!r) return null;
    return {
        jid: r.jid,
        isGroup: !!r.is_group,
        mode: r.mode,
        aiEnabled: !!r.ai_enabled,
        assignedTo: r.assigned_to,
        aiAgentId: r.ai_agent_id || null,
    };
}

/**
 * Actualiza dinámicamente los flags de control de una conversación
 * (mode / ai_enabled / assigned_to). Cualquier campo undefined se omite.
 * Devuelve true si afectó alguna fila.
 */
async function updateConversationFlags(pool, jid, { mode, aiEnabled, assignedTo, aiAgentId } = {}) {
    const sets = [];
    const params = [];
    if (mode !== undefined)       { sets.push('mode = ?');         params.push(mode); }
    if (aiEnabled !== undefined)  { sets.push('ai_enabled = ?');   params.push(aiEnabled ? 1 : 0); }
    if (assignedTo !== undefined) { sets.push('assigned_to = ?');  params.push(assignedTo); }
    if (aiAgentId !== undefined)  { sets.push('ai_agent_id = ?');  params.push(aiAgentId); }
    if (!sets.length) return false;
    params.push(jid);
    const [r] = await pool.query(
        `UPDATE wa_conversations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE jid = ?`,
        params
    );
    return r.affectedRows > 0;
}

/**
 * Persiste sent_by_user en el último mensaje saliente de una conversación
 * con un wa_message_id concreto. Best-effort: si no existe, no falla.
 */
async function tagSentByUser(pool, wa_message_id, userId) {
    if (!wa_message_id || !userId) return;
    await pool.query(
        `UPDATE wa_messages SET sent_by_user = ? WHERE wa_message_id = ?`,
        [userId, wa_message_id]
    );
}

/**
 * Marca como leída una conversación (resetea unread_count).
 */
async function markRead(pool, jid) {
    await pool.query(
        `UPDATE wa_conversations SET unread_count = 0 WHERE jid = ?`,
        [jid]
    );
}

/**
 * Enriquece nombres de conversación a partir de un evento chats.upsert.
 */
async function upsertChatNames(pool, chats) {
    if (!Array.isArray(chats) || !chats.length) return;
    for (const c of chats) {
        if (!c.id) continue;
        const name = c.name || c.subject || null;
        if (!name) continue;
        await pool.query(
            `INSERT INTO wa_conversations (jid, name, is_group)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = VALUES(name)`,
            [c.id, name, c.id.endsWith('@g.us') ? 1 : 0]
        );
    }
}

module.exports = {
    ingestMessage,
    recordOutbound,
    updateMessageStatus,
    listConversations,
    listMessages,
    markRead,
    upsertChatNames,
    getConversationFlags,
    updateConversationFlags,
    tagSentByUser,
};

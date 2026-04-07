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

    // 1) Insert mensaje (idempotente por wa_message_id)
    await pool.query(
        `INSERT IGNORE INTO wa_messages
            (jid, wa_message_id, from_me, sender, type, body, via, status, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jid, wa_message_id, from_me, sender, type, body, from_me ? 'api' : 'human', 'delivered', ts]
    );

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
        `SELECT id, jid, name, is_group, mode, ai_enabled, assigned_to,
                unread_count, last_message, last_ts, tags, created_at, updated_at
         FROM wa_conversations
         ORDER BY last_ts DESC
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
    updateMessageStatus,
    listConversations,
    listMessages,
    markRead,
    upsertChatNames,
};

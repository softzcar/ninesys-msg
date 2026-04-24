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
 * Desanida envelopes de Baileys (ephemeralMessage, viewOnceMessage,
 * documentWithCaptionMessage, editedMessage, viewOnceMessageV2[Extension]).
 * Espejo simplificado de `normalizeMessageContent` de Baileys; duplicado aquí
 * para no depender del módulo durante el upgrade ESM pendiente.
 *
 * Los chats recién creados con "mensajes temporales" activos llegan como
 * `ephemeralMessage.message.extendedTextMessage`; sin unwrap caerían a 'system'.
 */
function unwrapContent(msg) {
    let cur = msg;
    for (let i = 0; i < 5 && cur; i++) {
        const next =
            cur.ephemeralMessage?.message ||
            cur.viewOnceMessage?.message ||
            cur.viewOnceMessageV2?.message ||
            cur.viewOnceMessageV2Extension?.message ||
            cur.documentWithCaptionMessage?.message ||
            cur.editedMessage?.message;
        if (!next) break;
        cur = next;
    }
    return cur;
}

/**
 * Extrae el tipo principal del mensaje Baileys.
 */
function extractType(msg) {
    const m = unwrapContent(msg);
    if (!m) return 'system';
    if (m.conversation || m.extendedTextMessage) return 'text';
    if (m.imageMessage) return 'image';
    if (m.audioMessage) return 'audio';
    if (m.videoMessage) return 'video';
    if (m.documentMessage) return 'document';
    if (m.stickerMessage) return 'sticker';
    if (m.locationMessage) return 'location';
    if (m.contactMessage || m.contactsArrayMessage) return 'contact';
    return 'system';
}

/**
 * Extrae el body textual visible de un mensaje Baileys.
 */
function extractBody(msg) {
    const m = unwrapContent(msg);
    if (!m) return null;
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    if (m.documentMessage?.fileName) return m.documentMessage.fileName;
    if (m.audioMessage) return '[audio]';
    if (m.stickerMessage) return '[sticker]';
    if (m.locationMessage) return '[ubicación]';
    if (m.contactMessage) return `[contacto] ${m.contactMessage.displayName || ''}`;
    return null;
}

/**
 * Extrae el MIME type nativo del mensaje Baileys para tipos con media.
 */
function extractMime(msg) {
    const m = unwrapContent(msg);
    if (!m) return null;
    return m.imageMessage?.mimetype
        || m.audioMessage?.mimetype
        || m.videoMessage?.mimetype
        || m.documentMessage?.mimetype
        || m.stickerMessage?.mimetype
        || null;
}

const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker']);

/**
 * Upsert de un mensaje Baileys + actualización de la conversación.
 * Devuelve { jid, conversation, message } para que el caller pueda emitir
 * eventos al frontend.
 *
 * @param {Pool} pool
 * @param {object} m  - mensaje Baileys (proto.IWebMessageInfo)
 */
async function ingestMessage(pool, m, opts = {}) {
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

    // Descartamos envelopes de protocolo/setup que no son mensajes visibles:
    // protocolMessage (revoke, ephemeralSettings change), senderKeyDistributionMessage
    // (setup de grupo/sesión E2E), messageContextInfo solo, etc. Se reconocen
    // por caer al bucket 'system' sin body tras el unwrap. Si los persistiéramos,
    // la UI los pintaría como "[system]" y crearían conversaciones fantasma al
    // reconectar (Baileys hace un burst de estos por cada chat activo).
    if (type === 'system' && !body) {
        return null;
    }

    // Fase B.1: descargar media si aplica. El caller (waManager) provee el
    // handler que sabe usar Baileys + mediaStore. Si la descarga falla, seguimos
    // ingestando el mensaje sin media para no perder el registro.
    let media_url = null;
    let media_mime = extractMime(m.message);
    if (MEDIA_TYPES.has(type) && typeof opts.mediaHandler === 'function') {
        try {
            const saved = await opts.mediaHandler({ msg: m, type, waMessageId: wa_message_id, ts });
            if (saved) {
                media_url = saved.relativePath || null;
                media_mime = saved.mimeType || media_mime;
            }
        } catch (e) {
            // log best-effort; no rompemos el ingest
            if (opts.log) opts.log.warn({ err: e, wa_message_id, type }, 'media download falló');
        }
    }

    // 1) Insert mensaje (idempotente por wa_message_id). Si ya existía
    //    (p.ej. persistido por recordOutbound antes del upsert), salimos
    //    sin emitir nada para evitar eventos duplicados.
    const [ins] = await pool.query(
        `INSERT IGNORE INTO wa_messages
            (jid, wa_message_id, from_me, sender, type, body, media_url, media_mime, via, status, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [jid, wa_message_id, from_me, sender, type, body, media_url, media_mime,
         from_me ? 'api' : 'human', 'delivered', ts]
    );
    if (ins.affectedRows === 0) return null;

    // 2) Si la conversación estaba en papelera y llega nueva actividad,
    //    la restauramos (affectedRows > 0 cuando realmente cambió). Los
    //    mensajes antiguos quedan soft-deleted — solo vuelve a aparecer la
    //    conversación con el mensaje nuevo en adelante.
    const [restoreRes] = await pool.query(
        `UPDATE wa_conversations
         SET deleted_at = NULL, deleted_by = NULL
         WHERE jid = ? AND deleted_at IS NOT NULL`,
        [jid]
    );
    const restored = restoreRes.affectedRows > 0;

    // 3) Upsert conversación + bump last_*.
    //    mysql2 affectedRows: 1 = insert nuevo, 2 = update, 0 = sin cambios.
    //    Usamos conversationCreated para disparar auto-asignación a vendedor
    //    histórico solo cuando se crea la conversación por primera vez.
    const lastPreview = (body || `[${type}]`).slice(0, 500);
    const [upsertRes] = await pool.query(
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
    const conversationCreated = upsertRes.affectedRows === 1;

    return {
        jid,
        restored,
        conversationCreated,
        isGroup: !!isGroup,
        fromMe: !!from_me,
        message: { wa_message_id, from_me: !!from_me, sender, type, body, media_url, media_mime, ts, status: 'delivered' },
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
async function recordOutbound(pool, { jid, wa_message_id, body, type = 'text', status = 'sent', ts, via = 'api', media_url = null, media_mime = null }) {
    if (!jid || !wa_message_id) return null;
    const timestamp = Number(ts) || Math.floor(Date.now() / 1000);
    const isGroup = jid.endsWith('@g.us') ? 1 : 0;

    await pool.query(
        `INSERT INTO wa_messages
            (jid, wa_message_id, from_me, sender, type, body, media_url, media_mime, via, status, ts)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            status     = VALUES(status),
            body       = COALESCE(VALUES(body), body),
            media_url  = COALESCE(VALUES(media_url), media_url),
            media_mime = COALESCE(VALUES(media_mime), media_mime)`,
        [jid, wa_message_id, jid, type, body, media_url, media_mime, via, status, timestamp]
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
        message: { wa_message_id, from_me: true, sender: jid, type, body, media_url, media_mime, ts: timestamp, status, via },
        conversation: { jid, last_message: lastPreview, last_ts: timestamp, unread_delta: 0 },
    };
}

/**
 * Recupera la info de media de un mensaje por wa_message_id. Devuelve
 * { jid, media_url, media_mime, type, body } o null.
 */
async function getMediaByMessageId(pool, wa_message_id) {
    if (!wa_message_id) return null;
    const [rows] = await pool.query(
        `SELECT jid, type, body, media_url, media_mime
         FROM wa_messages WHERE wa_message_id = ? LIMIT 1`,
        [wa_message_id]
    );
    return rows[0] || null;
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
 * Por defecto excluye las soft-deleted. Usar includeDeleted=true para
 * verlas (p.ej. en la vista de papelera).
 *
 * Filtro por visibilidad (Fase D.1):
 *   - view='all'   → sin filtro de asignación (uso admin/supervisor).
 *   - view='queue' → solo sin asignar (assigned_to IS NULL) en modo humano.
 *                    Útil para la vista de "cola" que cualquier vendedor puede tomar.
 *   - view='mine'  → solo asignadas al userId recibido.
 *                    Default cuando se pasa userId.
 * Si no se pasan view ni userId se comporta como antes (= all).
 */
async function listConversations(pool, { limit = 100, includeDeleted = false, view, userId } = {}) {
    const where = [];
    const params = [];
    if (!includeDeleted) where.push('c.deleted_at IS NULL');

    const resolvedView = view || (userId != null ? 'mine' : 'all');
    if (resolvedView === 'mine') {
        if (userId == null) {
            // sin userId no podemos filtrar por "mío"; devolvemos vacío para
            // no exponer accidentalmente todo el inbox del tenant.
            return [];
        }
        where.push('c.assigned_to = ?');
        params.push(Number(userId));
    } else if (resolvedView === 'queue') {
        where.push("c.assigned_to IS NULL AND c.mode = 'human'");
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);

    const [rows] = await pool.query(
        `SELECT c.id, c.jid, c.name, c.is_group, c.mode, c.ai_enabled,
                c.assigned_to, c.owner_id, c.last_inbound_at,
                c.ai_agent_id, c.unread_count, c.last_message, c.last_ts, c.tags,
                c.created_at, c.updated_at, c.deleted_at, a.name AS agent_name
         FROM wa_conversations c
         LEFT JOIN wa_ai_agents a ON a.id = c.ai_agent_id
         ${whereSql}
         ORDER BY c.last_ts DESC
         LIMIT ?`,
        params
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
        ownerId: r.owner_id,
        lastInboundAt: r.last_inbound_at || null,
        aiAgentId: r.ai_agent_id || null,
        agentName: r.agent_name || null,
        deletedAt: r.deleted_at || null,
    }));
}

/**
 * Mensajes de una conversación, paginado por timestamp descendente.
 * Filtra los soft-deleted salvo que se pase includeDeleted=true.
 */
async function listMessages(pool, jid, { before = null, limit = 50, includeDeleted = false } = {}) {
    const params = [jid];
    let where = 'jid = ?';
    if (!includeDeleted) where += ' AND deleted_at IS NULL';
    if (before) {
        where += ' AND ts < ?';
        params.push(Number(before));
    }
    params.push(Number(limit));
    const [rows] = await pool.query(
        `SELECT id, wa_message_id, from_me, sender, type, body,
                transcript, transcript_lang,
                media_url, media_mime, via, status, ts, created_at
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
        transcript: r.transcript || null,
        transcript_lang: r.transcript_lang || null,
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
        `SELECT jid, is_group, mode, ai_enabled, assigned_to, owner_id,
                last_inbound_at, ai_agent_id
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
        ownerId: r.owner_id,
        lastInboundAt: r.last_inbound_at || null,
        aiAgentId: r.ai_agent_id || null,
    };
}

/**
 * Actualiza dinámicamente los flags de control de una conversación
 * (mode / ai_enabled / assigned_to / owner_id / last_inbound_at / ai_agent_id).
 * Cualquier campo undefined se omite.
 *
 * owner_id en esta función SOBRESCRIBE siempre; si se quiere "solo si era NULL",
 * usar claimOwnerIfEmpty en su lugar (respeta la política de ownership persistente).
 * lastInboundAt acepta Date | null.
 *
 * Devuelve true si afectó alguna fila.
 */
async function updateConversationFlags(pool, jid, {
    mode, aiEnabled, assignedTo, ownerId, lastInboundAt, aiAgentId,
} = {}) {
    const sets = [];
    const params = [];
    if (mode !== undefined)          { sets.push('mode = ?');            params.push(mode); }
    if (aiEnabled !== undefined)     { sets.push('ai_enabled = ?');      params.push(aiEnabled ? 1 : 0); }
    if (assignedTo !== undefined)    { sets.push('assigned_to = ?');     params.push(assignedTo); }
    if (ownerId !== undefined)       { sets.push('owner_id = ?');        params.push(ownerId); }
    if (lastInboundAt !== undefined) { sets.push('last_inbound_at = ?'); params.push(lastInboundAt); }
    if (aiAgentId !== undefined)     { sets.push('ai_agent_id = ?');     params.push(aiAgentId); }
    if (!sets.length) return false;
    params.push(jid);
    const [r] = await pool.query(
        `UPDATE wa_conversations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE jid = ?`,
        params
    );
    return r.affectedRows > 0;
}

/**
 * Setea owner_id SOLO si era NULL. Permite implementar "primer vendedor humano
 * que toma se queda con el cliente" sin pisar ownership existente cuando luego
 * hay reasignaciones temporales. Idempotente.
 *
 * Devuelve true si efectivamente se asignó (i.e. pasó de NULL → userId).
 */
async function claimOwnerIfEmpty(pool, jid, userId) {
    if (!jid || userId == null) return false;
    const [r] = await pool.query(
        `UPDATE wa_conversations
            SET owner_id = ?
          WHERE jid = ? AND owner_id IS NULL`,
        [Number(userId), jid]
    );
    return r.affectedRows > 0;
}

/**
 * Marca una conversación como asignada automáticamente a un vendedor
 * (auto-handoff, sin respuesta humana todavía). Atomic: actualiza mode,
 * ai_enabled, assigned_to, assigned_at y resetea last_vendor_reply_at en
 * una sola query.
 *
 * Si userId es null, la conversación queda en cola (assigned_to NULL,
 * assigned_at NULL).
 *
 * Parte del reloj de timeout (Fase D.3).
 */
async function recordAutoHandoff(pool, jid, userId) {
    if (!jid) return false;
    const isNull = userId == null;
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET mode = 'human',
             ai_enabled = 0,
             assigned_to = ?,
             assigned_at = ${isNull ? 'NULL' : 'CURRENT_TIMESTAMP'},
             last_vendor_reply_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE jid = ?`,
        [isNull ? null : Number(userId), jid]
    );
    return r.affectedRows > 0;
}

/**
 * Registra que un humano envió un mensaje (takeover manual o respuesta
 * continua). Atomic: mode='human', ai_enabled=0, assigned_to=userId,
 * last_vendor_reply_at=NOW(), y assigned_at se reinicia SOLO si cambia el
 * vendedor (se preserva si el mismo usuario re-responde).
 *
 * Parte del reloj de timeout (Fase D.3).
 */
async function recordHumanTakeover(pool, jid, userId) {
    if (!jid || userId == null) return false;
    const uid = Number(userId);
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET mode = 'human',
             ai_enabled = 0,
             assigned_at = CASE
                WHEN assigned_to IS NULL OR assigned_to <> ? THEN CURRENT_TIMESTAMP
                ELSE assigned_at
             END,
             assigned_to = ?,
             last_vendor_reply_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE jid = ?`,
        [uid, uid, jid]
    );
    return r.affectedRows > 0;
}

/**
 * Lista conversaciones candidatas a liberación por timeout: aquellas con
 * assigned_to != NULL, mode='human', no borradas, y con un reloj de
 * respuesta (last_vendor_reply_at o assigned_at) poblado.
 *
 * Devuelve { jid, assigned_to, assigned_at, last_vendor_reply_at } para que
 * el servicio de timeout calcule los minutos hábiles transcurridos.
 */
async function listAssignedForTimeout(pool, { limit = 500 } = {}) {
    const [rows] = await pool.query(
        `SELECT jid, assigned_to,
                last_vendor_reply_at, assigned_at
         FROM wa_conversations
         WHERE assigned_to IS NOT NULL
           AND mode = 'human'
           AND deleted_at IS NULL
           AND (last_vendor_reply_at IS NOT NULL OR assigned_at IS NOT NULL)
         ORDER BY COALESCE(last_vendor_reply_at, assigned_at) ASC
         LIMIT ?`,
        [Number(limit)]
    );
    return rows;
}

/**
 * Libera la asignación de una conversación (timeout). Deja mode='human'
 * para que la IA NO retome — que otro vendedor la tome desde la cola o que
 * el caller dispare una reasignación.
 *
 * NO toca owner_id (sticky persistente).
 */
async function releaseAssignment(pool, jid) {
    if (!jid) return false;
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET assigned_to = NULL,
             assigned_at = NULL,
             last_vendor_reply_at = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE jid = ? AND assigned_to IS NOT NULL`,
        [jid]
    );
    return r.affectedRows > 0;
}

/**
 * Lee el estado actual de asignación/modo de una conversación.
 * Usado por los controllers de D.4 para obtener `previousAssignee` antes
 * de un cambio y poder emitirlo en el evento WS.
 *
 * Devuelve null si la conversación no existe.
 */
async function getConversationAssignment(pool, jid) {
    if (!jid) return null;
    const [rows] = await pool.query(
        `SELECT assigned_to, owner_id, mode, ai_enabled
         FROM wa_conversations WHERE jid = ? LIMIT 1`,
        [jid]
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
        assignedTo: r.assigned_to,
        ownerId: r.owner_id,
        mode: r.mode,
        aiEnabled: !!r.ai_enabled,
    };
}

/**
 * D.4 — Devuelve la conversación a la cola (sin asignar, modo humano, IA
 * desactivada). Idempotente: se puede llamar aunque ya esté en cola y
 * sincroniza mode/ai_enabled igual. No toca owner_id (sticky).
 */
async function returnToQueue(pool, jid) {
    if (!jid) return false;
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET assigned_to = NULL,
             assigned_at = NULL,
             last_vendor_reply_at = NULL,
             mode = 'human',
             ai_enabled = 0,
             updated_at = CURRENT_TIMESTAMP
         WHERE jid = ?`,
        [jid]
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

/**
 * Soft delete: marca la conversación y todos sus mensajes como eliminados.
 * Idempotente: si ya está borrada no toca nada. Devuelve true si afectó
 * filas, false si la conversación no existía o ya estaba borrada.
 */
async function softDeleteConversation(pool, jid, userId = null) {
    if (!jid) return false;
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?
         WHERE jid = ? AND deleted_at IS NULL`,
        [userId, jid]
    );
    if (r.affectedRows === 0) return false;
    await pool.query(
        `UPDATE wa_messages SET deleted_at = CURRENT_TIMESTAMP
         WHERE jid = ? AND deleted_at IS NULL`,
        [jid]
    );
    return true;
}

/**
 * Restaurar una conversación soft-deleted y sus mensajes.
 */
async function restoreConversation(pool, jid) {
    if (!jid) return false;
    const [r] = await pool.query(
        `UPDATE wa_conversations
         SET deleted_at = NULL, deleted_by = NULL
         WHERE jid = ? AND deleted_at IS NOT NULL`,
        [jid]
    );
    if (r.affectedRows === 0) return false;
    await pool.query(
        `UPDATE wa_messages SET deleted_at = NULL
         WHERE jid = ? AND deleted_at IS NOT NULL`,
        [jid]
    );
    return true;
}

/**
 * Devuelve las rutas de media (media_url) asociadas a una conversación,
 * para que el caller pueda borrarlas del filesystem antes de purgar.
 */
async function listMediaPathsForJid(pool, jid) {
    if (!jid) return [];
    const [rows] = await pool.query(
        `SELECT media_url FROM wa_messages
         WHERE jid = ? AND media_url IS NOT NULL AND media_url <> ''`,
        [jid]
    );
    return rows.map((r) => r.media_url).filter(Boolean);
}

/**
 * Purga definitiva (hard delete) de una conversación: borra mensajes y
 * la conversación. El caller es responsable de limpiar archivos físicos
 * del mediaStore (listMediaPathsForJid ayuda con eso).
 * Devuelve true si borró la conversación.
 */
async function purgeConversation(pool, jid) {
    if (!jid) return false;
    await pool.query(`DELETE FROM wa_messages WHERE jid = ?`, [jid]);
    const [r] = await pool.query(`DELETE FROM wa_conversations WHERE jid = ?`, [jid]);
    return r.affectedRows > 0;
}

/**
 * Lista solo las conversaciones soft-deleted (papelera). Shape igual al
 * de listConversations para que el frontend pueda reusar el componente.
 */
async function listDeletedConversations(pool, { limit = 200 } = {}) {
    const [rows] = await pool.query(
        `SELECT c.jid, c.name, c.is_group, c.last_message, c.last_ts,
                c.deleted_at, c.deleted_by
         FROM wa_conversations c
         WHERE c.deleted_at IS NOT NULL
         ORDER BY c.deleted_at DESC
         LIMIT ?`,
        [limit]
    );
    return rows.map((r) => ({
        id: r.jid,
        name: r.name,
        isGroup: !!r.is_group,
        lastMessage: r.last_message,
        timestamp: r.last_ts,
        deletedAt: r.deleted_at,
        deletedBy: r.deleted_by,
    }));
}

/**
 * Devuelve los jids de todas las conversaciones soft-deleted, útil para
 * la purga masiva.
 */
async function listDeletedJids(pool) {
    const [rows] = await pool.query(
        `SELECT jid FROM wa_conversations WHERE deleted_at IS NOT NULL`
    );
    return rows.map((r) => r.jid);
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
    claimOwnerIfEmpty,
    tagSentByUser,
    // Fase D.3: reloj de timeout
    recordAutoHandoff,
    recordHumanTakeover,
    listAssignedForTimeout,
    releaseAssignment,
    // Fase D.4: reasignación manual
    getConversationAssignment,
    returnToQueue,
    getMediaByMessageId,
    // Soft delete / papelera
    softDeleteConversation,
    restoreConversation,
    purgeConversation,
    listDeletedConversations,
    listDeletedJids,
    listMediaPathsForJid,
};

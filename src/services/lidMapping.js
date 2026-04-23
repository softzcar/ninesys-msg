/**
 * lidMapping.js
 *
 * Persiste y resuelve el mapeo LID ↔ JID-fono. WhatsApp puede entregar
 * mensajes entrantes con `remoteJid = <numero>@lid` (Linked Identifier,
 * feature de privacidad) en vez del clásico `<tel>@s.whatsapp.net`. El LID
 * NO contiene el teléfono real, así que sin este mapeo no podemos mirar
 * `customers.phone` para identificar al cliente.
 *
 * Fuentes del par (hookeadas en waManager):
 *   - `contacts.upsert` / `contacts.update` — Contact.id + Contact.lid
 *   - `chats.phoneNumberShare`             — { lid, jid }
 *   - `messaging-history.set.contacts`     — dump inicial tras conectar
 *
 * Todas las operaciones son best-effort: si la escritura falla se loguea y
 * se sigue, jamás rompe el ingest de un mensaje.
 */

const log = require('../lib/logger').createLogger('lidMapping');

function isLidJid(jid)   { return typeof jid === 'string' && jid.endsWith('@lid'); }
function isPhoneJid(jid) { return typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'); }

/**
 * Guarda (o actualiza) un par LID↔JID-fono. Si el par ya existe solo refresca
 * `last_seen_at` y el pushname.
 *
 * Requiere AMBOS formatos válidos; descarta silenciosamente si falta uno.
 */
async function upsertMapping(pool, { lid, phoneJid, pushname } = {}) {
    if (!isLidJid(lid) || !isPhoneJid(phoneJid)) return false;
    try {
        const [r] = await pool.query(
            `INSERT INTO wa_lid_phone_map (lid_jid, phone_jid, pushname)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE
                phone_jid    = VALUES(phone_jid),
                pushname     = COALESCE(VALUES(pushname), pushname),
                last_seen_at = CURRENT_TIMESTAMP`,
            [lid, phoneJid, pushname || null]
        );
        if (r.affectedRows === 1) {
            log.info({ lid, phoneJid, pushname }, '[lidMapping] nuevo mapeo persistido');
        }
        return true;
    } catch (e) {
        log.warn({ err: e, lid, phoneJid }, '[lidMapping] upsert falló');
        return false;
    }
}

/**
 * Extrae un par (lid, phoneJid) a partir de un Contact de Baileys.
 * Baileys 6.17 expone Contact{ id, lid? }. El `id` puede ser phone-JID o LID;
 * el campo `lid` es siempre el LID cuando está presente.
 *
 * Devuelve {lid, phoneJid, pushname} o null si no hay par completo.
 */
function extractPairFromContact(contact) {
    if (!contact) return null;
    const pushname = contact.notify || contact.name || contact.verifiedName || null;
    const idIsLid   = isLidJid(contact.id);
    const idIsPhone = isPhoneJid(contact.id);
    const hasLid    = isLidJid(contact.lid);
    if (idIsPhone && hasLid) return { lid: contact.lid, phoneJid: contact.id, pushname };
    // Caso raro: id=@lid y no hay phone en otros campos → no mapeable.
    if (idIsLid && !hasLid) return null;
    // Caso sin LID conocido → no mapeable.
    if (idIsPhone && !hasLid) return null;
    return null;
}

/**
 * Persiste todos los mapeos derivables de una lista de Contact (batch).
 * Útil para hookear `contacts.upsert` y `messaging-history.set.contacts`.
 */
async function upsertFromContacts(pool, contacts) {
    if (!Array.isArray(contacts) || !contacts.length) return 0;
    let count = 0;
    for (const c of contacts) {
        const pair = extractPairFromContact(c);
        if (!pair) continue;
        const ok = await upsertMapping(pool, pair);
        if (ok) count++;
    }
    if (count) log.info({ count }, '[lidMapping] lote de contactos procesado');
    return count;
}

/**
 * Resuelve un LID al JID-fono correspondiente. Devuelve null si no hay
 * mapeo aún (el caller debe tratar como cliente desconocido).
 */
async function resolvePhoneJid(pool, lidJid) {
    if (!isLidJid(lidJid)) return null;
    try {
        const [rows] = await pool.query(
            `SELECT phone_jid FROM wa_lid_phone_map WHERE lid_jid = ? LIMIT 1`,
            [lidJid]
        );
        return rows[0]?.phone_jid || null;
    } catch (e) {
        log.warn({ err: e, lidJid }, '[lidMapping] resolvePhoneJid falló');
        return null;
    }
}

module.exports = {
    isLidJid,
    isPhoneJid,
    upsertMapping,
    upsertFromContacts,
    resolvePhoneJid,
};

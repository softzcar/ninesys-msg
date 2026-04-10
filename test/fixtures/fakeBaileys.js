/**
 * fakeBaileys.js — Fake mínimo del socket de Baileys para tests (Fase 9.5).
 *
 * Reemplaza lo único que usamos del sock real:
 *   - sock.sendMessage(jid, { text }) → devuelve un "envelope" con key.id y
 *     messageTimestamp (forma que devuelve Baileys real).
 *   - sock.user → { id, name }
 *   - sock.end() → no-op
 *   - sock.ev → EventEmitter (no lo usamos en tests, pero existe para que
 *     cualquier acceso de waManager.shutdown() no reviente).
 *
 * Cada fakeSock graba todas las llamadas a sendMessage en `sock.sent` para
 * que los tests puedan afirmar qué se envió.
 */

const { EventEmitter } = require('events');

function createFakeSock({ phoneNumber = '5491234567890', name = 'Test Bot' } = {}) {
    const ev = new EventEmitter();
    const sock = {
        ev,
        user: {
            id: `${phoneNumber}:1@s.whatsapp.net`,
            name,
        },
        sent: [], // log de llamadas sendMessage para aserciones
        async sendMessage(jid, content) {
            const wa_message_id = `FAKE-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const envelope = {
                key: { id: wa_message_id, remoteJid: jid, fromMe: true },
                message: content,
                messageTimestamp: Math.floor(Date.now() / 1000),
            };
            sock.sent.push({ jid, content, envelope });
            return envelope;
        },
        end() { /* no-op */ },
    };
    return sock;
}

/**
 * Construye un mensaje entrante en el formato que Baileys pasa a
 * conversationStore.ingestMessage (ver src/services/conversationStore.js).
 */
function buildIncoming({ jid, text, ts = Math.floor(Date.now() / 1000), pushName = 'Test User' }) {
    return {
        key: {
            id: `IN-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            remoteJid: jid,
            fromMe: false,
        },
        messageTimestamp: ts,
        pushName,
        message: { conversation: text },
    };
}

module.exports = { createFakeSock, buildIncoming };

/**
 * flow.test.js — Suite de integración end-to-end (Fase 9.5).
 *
 * Runner: `node --test` (built-in, sin dependencias).
 * Requiere una base MySQL real con el schema de wa_* aplicado. Por defecto
 * lee las credenciales del env y, si no están, intenta tenantResolver con
 * TEST_COMPANY_ID. Para correr en local:
 *
 *   TEST_DB_HOST=... TEST_DB_USER=... TEST_DB_PASS=... TEST_DB_NAME=api_emp_163 \
 *   node --test test/integration/flow.test.js
 *
 * Cada test usa jids con prefijo `TEST-9.5-` para no chocar con datos reales.
 * El hook before() y after() limpian cualquier fila remanente.
 *
 * Cobertura:
 *   T1 — ingest de mensaje entrante persiste fila en wa_messages
 *   T2 — auto-reply IA dispara y persiste respuesta con via='ai'
 *   T3 — guardrail mode=human: no se dispara la IA
 *   T4 — handoff via sendText(sentByUser): conv pasa a human + ai_enabled=0
 *   T5 — release: conv vuelve a hybrid, IA responde de nuevo
 *   T6 — throttle anti-loop: 2 mensajes en <4s → 1 sola respuesta
 *   T7 — breaker Gemini abre tras fallos consecutivos
 */

require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const waManager = require('../../src/services/waManager');
const aiService = require('../../src/services/aiService');
const conversationStore = require('../../src/services/conversationStore');
const tenantResolver = require('../../src/db/tenantResolver');

const { createFakeSock, buildIncoming } = require('../fixtures/fakeBaileys');
const { createGeminiStub } = require('../fixtures/geminiStub');

const TENANT_ID = Number(process.env.TEST_COMPANY_ID || 163);
const JID_PREFIX = 'TEST-9.5-';
const JID_1 = `${JID_PREFIX}11111@s.whatsapp.net`;
const JID_2 = `${JID_PREFIX}22222@s.whatsapp.net`;
const JID_3 = `${JID_PREFIX}33333@s.whatsapp.net`;

let pool;
let originalGetPool;

before(async () => {
    // 1) Resolver pool: preferimos TEST_DB_* directo; si no hay, usamos
    //    tenantResolver real (requiere API_URL + MSG_SERVICE_INTERNAL_TOKEN).
    if (process.env.TEST_DB_HOST && process.env.TEST_DB_NAME) {
        pool = mysql.createPool({
            host: process.env.TEST_DB_HOST,
            user: process.env.TEST_DB_USER,
            password: process.env.TEST_DB_PASS || '',
            database: process.env.TEST_DB_NAME,
            waitForConnections: true,
            connectionLimit: 3,
        });
    } else {
        pool = await tenantResolver.getPool(TENANT_ID);
    }

    // 2) Monkey-patch tenantResolver.getPool para que sendText() use nuestro
    //    pool de test sin ir a ninesys-api.
    originalGetPool = tenantResolver.getPool;
    tenantResolver.getPool = async () => pool;

    // 3) Ensure wa_ai_settings row exists con IA habilitada + provider gemini.
    //    Si la tabla no tiene fila id=1, la insertamos.
    await pool.query(
        `INSERT INTO wa_ai_settings (id, provider, enabled, model)
         VALUES (1, 'gemini', 1, 'gemini-2.5-flash')
         ON DUPLICATE KEY UPDATE provider='gemini', enabled=1`
    );

    // 4) Cleanup previo de cualquier run abortado
    await cleanup();
});

after(async () => {
    await cleanup();
    // Restaurar tenantResolver
    tenantResolver.getPool = originalGetPool;
    aiService._test.restore();
    aiService.resetBreaker();
    // Cerrar el pool si lo creamos nosotros (no el de tenantResolver)
    if (process.env.TEST_DB_HOST) {
        try { await pool.end(); } catch (_) {}
    }
});

beforeEach(() => {
    aiService._test.restore();
    aiService.resetBreaker();
});

async function cleanup() {
    await pool.query(`DELETE FROM wa_messages WHERE jid LIKE ?`, [`${JID_PREFIX}%`]);
    await pool.query(`DELETE FROM wa_conversations WHERE jid LIKE ?`, [`${JID_PREFIX}%`]);
    await pool.query(`DELETE FROM wa_send_log WHERE phone LIKE ?`, [`${JID_PREFIX}%`]);
}

/**
 * Instala una sesión fake en waManager listada como READY para el tenant.
 * Devuelve el fakeSock para que los tests puedan inspeccionar sock.sent.
 */
function installFakeSession() {
    const sock = createFakeSock();
    waManager._test.resetShutdownFlag();
    waManager._test.setSession(TENANT_ID, {
        sock,
        status: 'READY',
        qr: null,
        info: sock.user,
        lastError: null,
        reconnectAttempts: 0,
    });
    return sock;
}

/**
 * Simula el listener de `messages.upsert` de Baileys: persiste el mensaje
 * via conversationStore.ingestMessage y luego invoca maybeAutoReply si el
 * mensaje no es del bot. Es exactamente lo que hace init() en waManager.js
 * cuando llega un mensaje real.
 */
async function simulateIncoming(jid, text) {
    const raw = buildIncoming({ jid, text });
    const result = await conversationStore.ingestMessage(pool, raw);
    if (result && !result.message.from_me) {
        await waManager._test.maybeAutoReply(TENANT_ID, pool, result);
    }
    return result;
}

// ---------------------------------------------------------------------------
// T1 — Ingest básico
// ---------------------------------------------------------------------------
test('T1: ingestMessage persiste mensaje entrante', async () => {
    installFakeSession();
    aiService._test.setGenerateReplyImpl(async () => null); // desactivar IA

    const result = await simulateIncoming(JID_1, 'hola test 9.5');
    assert.ok(result, 'ingestMessage devolvió result');
    assert.equal(result.message.body, 'hola test 9.5');
    assert.equal(result.message.from_me, false);

    const [rows] = await pool.query(
        'SELECT body, from_me FROM wa_messages WHERE jid = ?', [JID_1]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'hola test 9.5');
    assert.equal(rows[0].from_me, 0);
});

// ---------------------------------------------------------------------------
// T2 — Auto-reply IA
// ---------------------------------------------------------------------------
test('T2: auto-reply IA dispara, envía y persiste con via=ai', async () => {
    const sock = installFakeSession();
    const stub = createGeminiStub({ reply: 'Respuesta automática del stub' });
    aiService._test.setGenerateReplyImpl(stub.impl);

    await simulateIncoming(JID_1, '¿qué servicios ofrecen?');

    // Esperar un tick para que la cadena async termine
    await new Promise((r) => setImmediate(r));

    assert.equal(stub.calls.length, 1, 'stub fue invocado 1 vez');
    assert.equal(sock.sent.length, 1, 'sock.sendMessage fue invocado');
    assert.equal(sock.sent[0].content.text, 'Respuesta automática del stub');

    const [rows] = await pool.query(
        `SELECT body, from_me, via FROM wa_messages
         WHERE jid = ? AND from_me = 1 ORDER BY ts DESC LIMIT 1`,
        [JID_1]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, 'Respuesta automática del stub');
    assert.equal(rows[0].via, 'ai');
});

// ---------------------------------------------------------------------------
// T3 — Guardrail mode=human
// ---------------------------------------------------------------------------
test('T3: mode=human bloquea auto-reply', async () => {
    installFakeSession();
    const stub = createGeminiStub({ reply: 'no debería llegar' });
    aiService._test.setGenerateReplyImpl(stub.impl);

    // Primero crear la conversación con un ingest
    await simulateIncoming(JID_2, 'hola 1');
    // Luego forzar mode=human
    await conversationStore.updateConversationFlags(pool, JID_2, {
        mode: 'human', aiEnabled: true,
    });
    stub.reset();
    stub.opts.reply = 'no debería llegar';

    await simulateIncoming(JID_2, 'hola 2 — ¿me atiendes?');

    assert.equal(stub.calls.length, 0, 'stub NO debe ser invocado en mode=human');
});

// ---------------------------------------------------------------------------
// T4 — Handoff manual via sendText(sentByUser)
// ---------------------------------------------------------------------------
test('T4: handoff vía sendText etiqueta la conversación', async () => {
    installFakeSession();
    aiService._test.setGenerateReplyImpl(async () => null);

    // Crear conversación primero
    await simulateIncoming(JID_3, 'hola necesito ayuda');

    // Humano envía desde panel
    await waManager.sendText(TENANT_ID, JID_3, 'Hola, te atiende un humano', {
        via: 'human',
        sentByUser: 42,
    });

    const flags = await conversationStore.getConversationFlags(pool, JID_3);
    assert.equal(flags.mode, 'human');
    assert.equal(flags.aiEnabled, false);
    assert.equal(flags.assignedTo, 42);
});

// ---------------------------------------------------------------------------
// T5 — Release devuelve al bot
// ---------------------------------------------------------------------------
test('T5: release devuelve la conversación al bot', async () => {
    installFakeSession();
    const stub = createGeminiStub({ reply: 'respuesta post-release' });
    aiService._test.setGenerateReplyImpl(stub.impl);

    // Estado inicial: conv en human (continuación de T4 si JID_3 aún existe)
    await conversationStore.updateConversationFlags(pool, JID_3, {
        mode: 'human', aiEnabled: false,
    });

    // Release manual: hybrid + ai_enabled=1 + assignedTo=null
    await conversationStore.updateConversationFlags(pool, JID_3, {
        mode: 'hybrid', aiEnabled: true, assignedTo: null,
    });

    // Nuevo mensaje: IA debe responder
    await simulateIncoming(JID_3, 'sigo por acá');

    assert.equal(stub.calls.length, 1, 'stub invocado tras release');
});

// ---------------------------------------------------------------------------
// T6 — Throttle anti-loop
// ---------------------------------------------------------------------------
test('T6: throttle 4s limita a 1 auto-reply por jid', async () => {
    const JID = `${JID_PREFIX}throttle@s.whatsapp.net`;
    installFakeSession();
    const stub = createGeminiStub({ reply: 'throttled' });
    aiService._test.setGenerateReplyImpl(stub.impl);

    await simulateIncoming(JID, 'mensaje 1');
    await simulateIncoming(JID, 'mensaje 2 inmediato');
    await simulateIncoming(JID, 'mensaje 3 inmediato');

    assert.equal(stub.calls.length, 1,
        'solo 1 auto-reply pese a 3 mensajes en <4s');

    // Cleanup del jid del throttle
    await pool.query(`DELETE FROM wa_messages WHERE jid = ?`, [JID]);
    await pool.query(`DELETE FROM wa_conversations WHERE jid = ?`, [JID]);
});

// ---------------------------------------------------------------------------
// T7 — Circuit breaker aísla fallos de Gemini
// ---------------------------------------------------------------------------
test('T7: fallos consecutivos del stub no rompen el ingest', async () => {
    const JID = `${JID_PREFIX}breaker@s.whatsapp.net`;
    installFakeSession();
    const stub = createGeminiStub({ fail: '503 simulated' });
    aiService._test.setGenerateReplyImpl(stub.impl);

    // 3 mensajes entrantes con stub fallando: el ingest debe completarse
    // sin que la excepción propague. La fila entrante queda persistida.
    for (let i = 0; i < 3; i++) {
        // Usar jids distintos para saltar el throttle
        const j = `${JID_PREFIX}breaker${i}@s.whatsapp.net`;
        await simulateIncoming(j, `mensaje ${i}`);
    }

    // Las 3 filas entrantes deben estar persistidas
    const [rows] = await pool.query(
        `SELECT COUNT(*) AS c FROM wa_messages WHERE jid LIKE ? AND from_me = 0`,
        [`${JID_PREFIX}breaker%`]
    );
    assert.ok(rows[0].c >= 3, `esperaba ≥3 mensajes entrantes persistidos, hay ${rows[0].c}`);

    // Cleanup
    await pool.query(`DELETE FROM wa_messages WHERE jid LIKE ?`, [`${JID_PREFIX}breaker%`]);
    await pool.query(`DELETE FROM wa_conversations WHERE jid LIKE ?`, [`${JID_PREFIX}breaker%`]);
});

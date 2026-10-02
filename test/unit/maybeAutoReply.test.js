/**
 * maybeAutoReply.test.js — el ejecutor de producción sigue enviando lo mismo
 * tras extraer la interpretación a aiReplyPlanner. Sin BD: pool y socket falsos.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GEMINI_API_KEY; // el clasificador de handoff devuelve 'none' sin llamar a la red

const waManager = require('../../src/services/waManager');
const aiService = require('../../src/services/aiService');
const tenantResolver = require('../../src/db/tenantResolver');
const { createFakeSock } = require('../fixtures/fakeBaileys');
const { TEXTS } = require('../../src/lib/aiReplyPlanner');

const TENANT = 99901;

function createFakePool() {
    const calls = [];
    return {
        driver: 'mysql',
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (/FROM wa_conversations WHERE jid = \?/.test(sql)) {
                return [[{ jid: params[0], is_group: 0, mode: 'hybrid', ai_enabled: 1, ai_agent_id: null }], []];
            }
            if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }, []];
            return [[], []];
        },
    };
}

let pool, sock, origGetPool, origLoadSettings;
before(() => {
    pool = createFakePool();
    sock = createFakeSock();
    origGetPool = tenantResolver.getPool;
    origLoadSettings = aiService.loadSettings;
    tenantResolver.getPool = async () => pool;
    aiService.loadSettings = async () => ({ enabled: true, provider: 'gemini' });
    waManager._test.setSession(TENANT, { status: 'READY', sock });
});
after(() => {
    tenantResolver.getPool = origGetPool;
    aiService.loadSettings = origLoadSettings;
    aiService._test.restore();
});

const ingest = (jid, body) => ({ jid, message: { body, from_me: false, key: {} } });
const sentTexts = (jid) => sock.sent.filter((s) => s.jid === jid).map((s) => s.content.text);

test('respuesta con markers: envía texto limpio, registra wa_send_log y escala', { timeout: 20000 }, async () => {
    const jid = '584140000001@s.whatsapp.net';
    aiService._test.setGenerateReplyImpl(async () => ({
        text: 'Listo, te paso con un asesor [HANDOFF_IA] [PRESUPUESTO_DATA]{"items":[]}[/PRESUPUESTO_DATA]',
        functionCalls: [],
        model: 'gemini-test',
    }));
    await waManager._test.maybeAutoReply(TENANT, pool, ingest(jid, 'hola'));

    assert.deepEqual(sentTexts(jid), ['Listo, te paso con un asesor']);
    const log = pool.calls.find((c) => /INSERT INTO wa_send_log/.test(c.sql));
    assert.ok(log, 'debe registrar wa_send_log');
    assert.deepEqual(log.params, ['ai_auto', jid, 'gemini:gemini-test']);
});

test('generateReply null → fallback genérico sin typing ni wa_send_log', { timeout: 5000 }, async () => {
    const jid = '584140000002@s.whatsapp.net';
    const before = pool.calls.length;
    aiService._test.setGenerateReplyImpl(async () => null);
    await waManager._test.maybeAutoReply(TENANT, pool, ingest(jid, 'hola'));
    await new Promise((r) => setImmediate(r)); // el envío del fallback no se espera

    assert.deepEqual(sentTexts(jid), [TEXTS.NULL_REPLY]);
    assert.ok(!pool.calls.slice(before).some((c) => /wa_send_log/.test(c.sql)));
});

test('gemini_failed → fallback técnico', { timeout: 5000 }, async () => {
    const jid = '584140000003@s.whatsapp.net';
    aiService._test.setGenerateReplyImpl(async () => ({ text: null, error: 'gemini_failed', model: 'x' }));
    await waManager._test.maybeAutoReply(TENANT, pool, ingest(jid, 'hola'));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sentTexts(jid), [TEXTS.GEMINI_FAILED]);
});

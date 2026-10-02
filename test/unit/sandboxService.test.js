/**
 * sandboxService.test.js — simulador del bot: flujo de presupuesto, handoff
 * y AISLAMIENTO (un turno no debe enviar, escalar ni escribir conversaciones).
 * Sin BD ni red: pool falso + generateReply/clasificador stubs.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

delete process.env.GEMINI_API_KEY;

const waManager = require('../../src/services/waManager');
const aiService = require('../../src/services/aiService');
const conversationStore = require('../../src/services/conversationStore');
const customerLookup = require('../../src/services/customerLookup');
const presupuestoService = require('../../src/services/presupuestoService');
const intentClassifier = require('../../src/lib/intentClassifier');
const sandbox = require('../../src/services/sandboxService');
const controller = require('../../controllers/aiSandboxController');
const { TEXTS } = require('../../src/lib/aiReplyPlanner');

const SESSION = '0123456789abcdef0123456789abcdef';
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)/i;

function createFakePool() {
    const calls = [];
    return {
        driver: 'mysql',
        calls,
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (/FROM customers WHERE _id = \?/.test(sql)) {
                return [[{ _id: params[0], first_name: 'Ana', last_name: 'Pérez', phone: '584141112233' }], []];
            }
            return [[], []];
        },
    };
}

// Todo lo que el simulador NUNCA debe tocar: si se llama, el test falla.
const FORBIDDEN = [
    [waManager, 'sendText'], [waManager, 'sendMedia'], [waManager, 'handoffToHuman'],
    [presupuestoService, 'submit'],
    [conversationStore, 'ingestMessage'], [conversationStore, 'recordOutbound'],
    [conversationStore, 'updateConversationFlags'],
    [customerLookup, 'findCustomerByJid'],
];
const originals = [];
let classifierResult = 'none';
let lastGenerateParams = null;

before(() => {
    for (const [mod, fn] of FORBIDDEN) {
        if (typeof mod[fn] !== 'function') continue;
        originals.push([mod, fn, mod[fn]]);
        mod[fn] = () => { throw new Error(`el simulador llamó a ${fn}`); };
    }
    originals.push([intentClassifier, 'classifyHandoffIntent', intentClassifier.classifyHandoffIntent]);
    intentClassifier.classifyHandoffIntent = async () => classifierResult;
    originals.push([customerLookup, 'findLastEligibleVendor', customerLookup.findLastEligibleVendor]);
    customerLookup.findLastEligibleVendor = async () => 42;
});
after(() => {
    for (const [mod, fn, orig] of originals) mod[fn] = orig;
    aiService._test.restore();
});
beforeEach(() => { classifierResult = 'none'; lastGenerateParams = null; });

const stubReply = (reply) => aiService._test.setGenerateReplyImpl(async (p) => { lastGenerateParams = p; return reply; });
const turn = (pool, text, extra = {}) => sandbox.simulateTurn({ idEmpresa: 1, pool, sessionId: SESSION, text, ...extra });
const assertNoWrites = (pool) => assert.deepEqual(pool.calls.filter((c) => WRITE_RE.test(c.sql)), []);

test('turno normal: parámetros aislados hacia generateReply y texto al historial', async () => {
    const pool = createFakePool();
    stubReply({ text: 'Hola 👋', functionCalls: [], model: 'm' });
    const r = await turn(pool, 'hola', { draft: { systemPrompt: 'BORRADOR' }, agentId: 3 });

    assert.equal(lastGenerateParams.isolated, true);
    assert.equal(lastGenerateParams.ignoreEnabled, true);
    assert.equal(lastGenerateParams.usageProvider, 'gemini_sandbox');
    assert.deepEqual(lastGenerateParams.overrides, { systemPrompt: 'BORRADOR' });
    assert.equal(lastGenerateParams.agentId, 3);
    assert.match(lastGenerateParams.jid, /^sandbox-[a-z0-9]+@sandbox\.local$/);
    assert.deepEqual(lastGenerateParams.history.at(-1), { from_me: 0, type: 'text', body: 'hola' });

    assert.deepEqual(r.turn.messages, [{ type: 'text', body: 'Hola 👋', via: 'ai' }]);
    assert.deepEqual(r.history.map((m) => [m.from_me, m.body]), [[0, 'hola'], [1, 'Hola 👋']]);
    assertNoWrites(pool);
});

test('presupuesto: función → pendiente; "sí" → vista previa, sin escribir y sin IA', async () => {
    const pool = createFakePool();
    const data = { cliente: { nombre: 'Ana' }, items: [{ productoNombre: 'Franela', cod: 5, idCategory: 2, cantidad: 3, precio: 10 }] };
    stubReply({ text: '', functionCalls: [{ name: 'submit_presupuesto', args: data }], model: 'm' });
    const r1 = await turn(pool, 'quiero 3 franelas');
    assert.deepEqual(r1.state.pendingPresupuesto, data);
    assert.equal(r1.turn.messages[0].body, TEXTS.CONFIRM_FALLBACK);
    assert.ok(r1.turn.actions.some((a) => a.type === 'presupuesto_pendiente'));

    stubReply(null);
    lastGenerateParams = null;
    const r2 = await turn(pool, 'sí', { history: r1.history, state: r1.state });
    assert.equal(lastGenerateParams, null, 'la confirmación no debe llamar a la IA');
    assert.equal(r2.state.pendingPresupuesto, null);
    const create = r2.turn.actions.find((a) => a.type === 'would_create_presupuesto');
    assert.equal(create.preview.ok, true);
    assert.equal(create.preview.total, 30);
    assert.ok(r2.turn.actions.some((a) => a.type === 'would_handoff' && a.reason === 'presupuesto_generado'));
    assert.equal(r2.turn.messages[0].body, TEXTS.PRESUPUESTO_OK('SIMULADO') + TEXTS.API_FOOTER);
    assertNoWrites(pool);
});

test('presupuesto con producto fuera de catálogo → invalid_catalog', async () => {
    const pool = createFakePool();
    const state = { pendingPresupuesto: { items: [{ productoNombre: 'X', idCategory: 0 }] } };
    const r = await turn(pool, 'ok', { state });
    const create = r.turn.actions.find((a) => a.type === 'would_create_presupuesto');
    assert.equal(create.preview.reason, 'invalid_catalog');
    assert.equal(r.turn.messages[0].body, TEXTS.PRESUPUESTO_INVALID_CATALOG + TEXTS.API_FOOTER);
});

test('human_request: respuesta fija y would_handoff, sin escalar de verdad', async () => {
    const pool = createFakePool();
    classifierResult = 'human_request';
    stubReply({ text: 'ignorada', functionCalls: [], model: 'm' });
    const r = await turn(pool, 'quiero hablar con una persona');
    assert.deepEqual(r.turn.messages.map((m) => m.body), [TEXTS.HUMAN_REQUEST]);
    assert.ok(r.turn.actions.some((a) => a.type === 'would_handoff' && a.reason === 'cliente_solicita'));
    assertNoWrites(pool);
});

test('frustrated: respuesta + texto de transición + would_handoff', async () => {
    const pool = createFakePool();
    classifierResult = 'frustrated';
    stubReply({ text: 'Lo siento mucho', functionCalls: [], model: 'm' });
    const r = await turn(pool, 'esto es un desastre');
    assert.deepEqual(r.turn.messages.map((m) => m.body), ['Lo siento mucho', TEXTS.FRUSTRATED]);
    assert.ok(r.turn.actions.some((a) => a.type === 'would_handoff' && a.trigger === 'classifier'));
});

test('BAJA: acción simulada sin tocar customers ni llamar a la IA', async () => {
    const pool = createFakePool();
    lastGenerateParams = null;
    const r = await turn(pool, 'baja');
    assert.equal(lastGenerateParams, null);
    assert.deepEqual(r.turn.actions, [{ type: 'would_update_notifications', value: 0 }]);
    assertNoWrites(pool);
});

test('como cliente registrado: bloque CLIENTE REGISTRADO + aviso de vendedor histórico', async () => {
    const pool = createFakePool();
    stubReply({ text: 'Hola Ana', functionCalls: [], model: 'm' });
    const r = await turn(pool, 'mis pedidos', { asCustomer: { customerId: 7 } });
    assert.match(lastGenerateParams.extraSystemContext, /CLIENTE REGISTRADO[\s\S]*Ana Pérez/);
    assert.equal(lastGenerateParams.registeredPhone, '584141112233');
    assert.ok(r.turn.actions.some((a) => a.type === 'note_auto_assign' && a.vendorId === 42));
});

test('engine desconocido → error engine_not_supported', async () => {
    await assert.rejects(turn(createFakePool(), 'hola', { engine: 'mcp' }), { code: 'engine_not_supported' });
});

test('sesiones: otro usuario no puede usar ni resetear la sesión; el barrido la expira', () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    assert.equal(sandbox.touchSession(id, 1, 10), true);
    assert.equal(sandbox.touchSession(id, 1, 11), false);
    assert.equal(sandbox.resetSession(id, 2, 10), false);
    sandbox._test.sweepSessions(Date.now() + 3 * 60 * 60 * 1000);
    assert.equal(sandbox._test.sessions.has(id), false);
});

test('controller: validación del borrador', () => {
    const { validateDraft } = controller._test;
    assert.equal(validateDraft(null), null);
    assert.deepEqual(validateDraft({ knowledgeBase: '{"a":1}', temperature: '0.5' }), { knowledgeBase: { a: 1 }, temperature: 0.5 });
    assert.throws(() => validateDraft({ model: 'gpt-4' }), /modelo no permitido/);
    assert.throws(() => validateDraft({ knowledgeBase: '{roto' }), /JSON/);
    assert.throws(() => validateDraft({ temperature: 5 }), /rango/);
});

test('controller: rate limit (concurrencia y por minuto)', () => {
    const { rateLimit, inFlight } = controller._test;
    inFlight.add('9:1');
    assert.equal(rateLimit('9:1', 9), 'busy');
    inFlight.delete('9:1');
    for (let i = 0; i < 20; i++) assert.equal(rateLimit('9:2', 9), null);
    assert.equal(rateLimit('9:2', 9), 'per_minute');
});

/**
 * aiReplyPlanner.test.js — caracterización de la interpretación de respuestas IA.
 *
 * Fija el comportamiento que tenía waManager.maybeAutoReply antes de extraer
 * la lógica a src/lib/aiReplyPlanner.js. Sin BD ni red.
 *
 *   node --test test/unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    planAiReply, planConfirmation, buildClienteRegistradoCtx, TEXTS, RETRY_CONFIRM_INSTRUCTION,
} = require('../../src/lib/aiReplyPlanner');

const CDN = 'https://cdn.test.com';
const ops = (plan) => plan.stateOps.map((o) => o.op);
const run = (reply, extra = {}) => planAiReply({ reply, intentResult: 'none', cdnUrl: CDN, ...extra });

test('human_request descarta la respuesta de la IA y escala', async () => {
    const plan = await planAiReply({ reply: { text: 'hola' }, intentResult: 'human_request', cdnUrl: CDN });
    assert.equal(plan.kind, 'human_request');
    assert.equal(plan.textToSend, TEXTS.HUMAN_REQUEST);
    assert.deepEqual(plan.handoff, { reason: 'cliente_solicita', trigger: 'classifier', transitionText: null });
    assert.deepEqual(plan.stateOps, []);
});

test('reply null → fallback genérico sin handoff', async () => {
    const plan = await run(null);
    assert.equal(plan.kind, 'null_reply');
    assert.equal(plan.textToSend, TEXTS.NULL_REPLY);
    assert.equal(plan.handoff, null);
});

test('gemini_failed → fallback técnico', async () => {
    const plan = await run({ text: null, error: 'gemini_failed' });
    assert.equal(plan.kind, 'gemini_failed');
    assert.equal(plan.textToSend, TEXTS.GEMINI_FAILED);
});

test('texto simple pasa limpio', async () => {
    const plan = await run({ text: '  Hola, ¿en qué te ayudo?  ', functionCalls: [] });
    assert.equal(plan.kind, 'reply');
    assert.equal(plan.textToSend, 'Hola, ¿en qué te ayudo?');
    assert.deepEqual(plan.imgUrls, []);
    assert.equal(plan.handoff, null);
});

test('galería por función con URL válida', async () => {
    const url = `${CDN}/gallery/franelas/a.jpg`;
    const plan = await run({ text: 'Mira este', functionCalls: [{ name: 'send_gallery_image', args: { url } }] });
    assert.deepEqual(plan.imgUrls, [url]);
    assert.equal(plan.gallerySource, 'function');
    assert.equal(plan.textToSend, 'Mira este');
});

test('galería por función con URL inválida y sin texto → aclaración con carpetas reales', async () => {
    const plan = await run(
        { text: '', functionCalls: [{ name: 'send_gallery_image', args: { url: 'https://otro.com/x.jpg' } }] },
        { listFolders: async () => ['franelas', 'gorras', 'tazas', 'chemises', 'mangas'] },
    );
    assert.deepEqual(plan.imgUrls, []);
    assert.equal(plan.invalidGalleryUrl, 'https://otro.com/x.jpg');
    assert.match(plan.textToSend, /franelas, gorras, tazas, chemises, etc\./);
    assert.deepEqual(ops(plan), ['set_gallery_clarification']);
});

test('galería por función inválida sin carpetas → pregunta genérica', async () => {
    const plan = await run({ text: '', functionCalls: [{ name: 'send_gallery_image', args: { url: 'https://x.com/a' } }] });
    assert.equal(plan.textToSend, '¿De qué producto te gustaría ver diseños?');
});

test('marker [IMG:] filtra hosts ajenos, máximo 4 y se quita del texto', async () => {
    const urls = [1, 2, 3, 4, 5].map((n) => `${CDN}/g/${n}.jpg`);
    const text = `Aquí tienes [IMG:${urls.join('|')}|https://malo.com/z.jpg]`;
    const plan = await run({ text, functionCalls: [] });
    assert.deepEqual(plan.imgUrls, urls.slice(0, 4));
    assert.equal(plan.gallerySource, 'marker');
    assert.equal(plan.textToSend, 'Aquí tienes');
});

test('imagen sin texto → texto de respaldo con término de galería', async () => {
    const url = `${CDN}/g/1.jpg`;
    const plan = await run(
        { text: '', functionCalls: [{ name: 'send_gallery_image', args: { url } }] },
        { urlToGalleryTerm: new Map([[url, 'franelas']]) },
    );
    assert.match(plan.textToSend, /un modelo de franelas/);
});

test('imagen sin texto y sin término → "¡Aquí te muestro!"', async () => {
    const plan = await run({ text: '', functionCalls: [{ name: 'send_gallery_image', args: { url: `${CDN}/g/1.jpg` } }] });
    assert.equal(plan.textToSend, '¡Aquí te muestro!');
});

test('submit_presupuesto por función sin texto → confirmación de respaldo', async () => {
    const args = { cliente: { nombre: 'Ana' }, items: [] };
    const plan = await run({ text: '', functionCalls: [{ name: 'submit_presupuesto', args }] });
    assert.equal(plan.textToSend, TEXTS.CONFIRM_FALLBACK);
    assert.deepEqual(plan.presupuesto, { data: args, source: 'function', parseError: null });
    assert.deepEqual(ops(plan), ['set_pending_presupuesto', 'clear_confirm_sin_marker']);
});

test('marker [PRESUPUESTO_DATA] válido (tag abreviado) se extrae', async () => {
    const plan = await run({ text: 'Resumen listo [PRESUPUEDATA]{"items":[1]}[/PRESUPUEDATA]', functionCalls: [] });
    assert.equal(plan.textToSend, 'Resumen listo');
    assert.deepEqual(plan.presupuesto.data, { items: [1] });
    assert.equal(plan.presupuesto.source, 'marker');
    assert.deepEqual(ops(plan), ['set_pending_presupuesto', 'clear_confirm_sin_marker']);
});

test('marker [PRESUPUESTO_DATA] con JSON roto → sin pendiente pero limpia el flag', async () => {
    const plan = await run({ text: '[PRESUPUESTO_DATA]{roto[/PRESUPUESTO_DATA]', functionCalls: [] });
    assert.equal(plan.textToSend, TEXTS.CONFIRM_FALLBACK);
    assert.ok(plan.presupuesto.parseError);
    assert.deepEqual(ops(plan), ['clear_confirm_sin_marker']);
});

test('resumen "¿Confirmas este presupuesto?" sin marker → espera retry', async () => {
    const plan = await run({ text: 'Total 10$. ¿Confirmas este presupuesto?', functionCalls: [] });
    assert.deepEqual(ops(plan), ['set_confirm_sin_marker']);
    assert.equal(plan.presupuesto, null);
});

test('referencias internas [cod:][idCat:] nunca llegan al cliente', async () => {
    const plan = await run({
        text: 'Tenemos Franela Sublimada [cod:3][idCat:1] a partir de *$20.00*.\n👕 *Chemise:* [cod:7] [idCat:2]\n• Gorra [idCat:4]',
        functionCalls: [],
    });
    assert.equal(plan.textToSend, 'Tenemos Franela Sublimada a partir de *$20.00*.\n👕 *Chemise:*\n• Gorra');
});

test('texto sin referencias de catálogo no se altera', async () => {
    const plan = await run({ text: 'Precio [especial] por 12 unidades', functionCalls: [] });
    assert.equal(plan.textToSend, 'Precio [especial] por 12 unidades');
});

test('[HANDOFF_IA] se quita del texto y escala sin texto de transición', async () => {
    const plan = await run({ text: 'Te paso con un asesor [HANDOFF_IA]', functionCalls: [] });
    assert.equal(plan.textToSend, 'Te paso con un asesor');
    assert.deepEqual(plan.handoff, { reason: 'ia_no_puede', trigger: 'marker', transitionText: null });
});

test('[HANDOFF_CLIENTE] se quita pero no escala', async () => {
    const plan = await run({ text: 'Ok [HANDOFF_CLIENTE]', functionCalls: [] });
    assert.equal(plan.textToSend, 'Ok');
    assert.equal(plan.handoff, null);
});

test('frustrated tiene prioridad sobre el marker y agrega texto de transición', async () => {
    const plan = await planAiReply({ reply: { text: 'Lo siento [HANDOFF_IA]' }, intentResult: 'frustrated', cdnUrl: CDN });
    assert.equal(plan.textToSend, 'Lo siento');
    assert.deepEqual(plan.handoff, { reason: 'ia_no_puede', trigger: 'classifier', transitionText: TEXTS.FRUSTRATED });
});

test('detección de HANDOFF_IA es estable en llamadas repetidas (sin lastIndex)', async () => {
    for (let i = 0; i < 3; i++) {
        const plan = await run({ text: 'x [HANDOFF_IA]' });
        assert.equal(plan.handoff?.trigger, 'marker');
    }
});

// ── planConfirmation ──────────────────────────────────────────────────────
test('planConfirmation: pendiente + "sí" → submit', () => {
    assert.equal(planConfirmation({ pendingPres: {}, body: ' Sí ' }).action, 'submit');
    assert.equal(planConfirmation({ pendingPres: {}, body: 'dale' }).action, 'submit');
});

test('planConfirmation: pendiente + otra cosa → cancel_pending', () => {
    assert.deepEqual(planConfirmation({ pendingPres: {}, confirmSinMarker: true, body: 'mejor no' }),
        { action: 'cancel_pending', extraCtx: '' });
});

test('planConfirmation: resumen sin marker + "ok" → retry con instrucción', () => {
    assert.deepEqual(planConfirmation({ pendingPres: null, confirmSinMarker: true, body: 'ok' }),
        { action: 'retry_with_instruction', extraCtx: RETRY_CONFIRM_INSTRUCTION });
});

test('planConfirmation: nada pendiente → none', () => {
    assert.equal(planConfirmation({ pendingPres: null, confirmSinMarker: false, body: 'sí' }).action, 'none');
});

// ── buildClienteRegistradoCtx ─────────────────────────────────────────────
test('buildClienteRegistradoCtx arma el bloque y omite campos vacíos', () => {
    const r = buildClienteRegistradoCtx({ _id: 7, first_name: 'Ana', last_name: 'Pérez', phone: '58414', cedula: '', email: 'a@b.c' });
    assert.equal(r.customerId, 7);
    assert.equal(r.registeredPhone, '58414');
    assert.equal(r.nombre, 'Ana Pérez');
    assert.match(r.ctx, /Nombre: Ana Pérez/);
    assert.match(r.ctx, /Email: a@b\.c/);
    assert.doesNotMatch(r.ctx, /Cédula:/);
    assert.deepEqual(buildClienteRegistradoCtx(null), { ctx: '', registeredPhone: null, customerId: null, nombre: '' });
});

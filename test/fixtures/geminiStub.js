/**
 * geminiStub.js — Stub de aiService.generateReply para tests (Fase 9.5).
 *
 * Uso:
 *   const stub = createGeminiStub({ reply: 'ECHO' });
 *   aiService._test.setGenerateReplyImpl(stub.impl);
 *
 *   // ... ejecutar código bajo test ...
 *
 *   assert.equal(stub.calls.length, 2);
 *   assert.equal(stub.calls[0].jid, '...');
 *
 * Opciones:
 *   - reply: string fijo a devolver (default: "ECHO: <incomingText>")
 *   - fail: si true, lanza Error para simular fallos
 *   - delayMs: retraso artificial para probar throttle
 */

function createGeminiStub(opts = {}) {
    const calls = [];
    const stub = {
        calls,
        reset() { calls.length = 0; stub.opts = { ...opts }; },
        opts: { ...opts },
        async impl(params) {
            calls.push({ jid: params.jid, incomingText: params.incomingText });
            if (stub.opts.delayMs) {
                await new Promise((r) => setTimeout(r, stub.opts.delayMs));
            }
            if (stub.opts.fail) {
                throw new Error(stub.opts.fail === true ? 'stub forced failure' : stub.opts.fail);
            }
            const text = stub.opts.reply
                ? (typeof stub.opts.reply === 'function'
                    ? stub.opts.reply(params)
                    : stub.opts.reply)
                : `ECHO: ${params.incomingText || ''}`;
            return { text, model: 'stub-gemini' };
        },
    };
    // bind impl para que `this` funcione si alguien lo llama suelto
    stub.impl = stub.impl.bind(stub);
    return stub;
}

module.exports = { createGeminiStub };

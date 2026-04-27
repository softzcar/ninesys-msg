/**
 * geminiPricing.js
 *
 * Tabla de precios de Gemini por modelo (USD por millón de tokens).
 * Fuente: https://ai.google.dev/pricing (revisado 2026-04)
 *
 * costUsd(modelId, usageMetadata) → USD como número flotante.
 * Si el modelo no está en la tabla se aplica el precio de flash (conservador).
 */

// Precios en USD por 1 000 000 de tokens.
// `thinking` aplica a modelos 2.5 que generan tokens de razonamiento interno
// (thoughtsTokenCount en usageMetadata). Los modelos 2.0/1.x no tienen thinking.
const PRICE_PER_MILLION = {
    // Gemini 2.5
    'gemini-2.5-flash': { input: 0.15,   output: 0.60,  thinking: 3.50 },
    'gemini-2.5-pro':   { input: 1.25,   output: 10.00, thinking: 3.50 },
    // Gemini 2.0
    'gemini-2.0-flash':      { input: 0.10,  output: 0.40  },
    'gemini-2.0-flash-lite': { input: 0.075, output: 0.30  },
    // Gemini 1.5
    'gemini-1.5-flash':    { input: 0.075,  output: 0.30 },
    'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
    'gemini-1.5-pro':      { input: 1.25,   output: 5.00 },
    // Gemini 1.0
    'gemini-1.0-pro': { input: 0.50, output: 1.50 },
};

const FALLBACK = PRICE_PER_MILLION['gemini-2.5-flash'];

/**
 * @param {string} modelId  — p.ej. 'gemini-2.5-flash' (puede incluir versión/variante)
 * @param {object} usage    — usageMetadata del SDK: { promptTokenCount, candidatesTokenCount }
 * @returns {number} costo en USD
 */
function costUsd(modelId, usage) {
    if (!usage) return 0;

    // Normalizar: el SDK puede devolver 'models/gemini-2.5-flash' o variantes con '-preview-NNNN'
    const normalized = String(modelId || '')
        .replace(/^models\//, '')
        .replace(/-preview-\d+$/, '')
        .replace(/-\d{8}$/, '')    // sufijos de fecha
        .toLowerCase();

    let prices = FALLBACK;
    for (const key of Object.keys(PRICE_PER_MILLION)) {
        if (normalized.startsWith(key) || normalized === key) {
            prices = PRICE_PER_MILLION[key];
            break;
        }
    }

    const inputTokens    = Number(usage.promptTokenCount     || 0);
    const outputTokens   = Number(usage.candidatesTokenCount || 0);
    const thinkingTokens = Number(usage.thoughtsTokenCount   || 0);

    return (
        inputTokens    * prices.input +
        outputTokens   * prices.output +
        thinkingTokens * (prices.thinking || 0)
    ) / 1_000_000;
}

module.exports = { costUsd };

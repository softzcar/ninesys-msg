/**
 * intentClassifier.js
 *
 * Clasifica la intención de escalar que hay detrás del mensaje de un cliente,
 * usando una llamada rápida a Gemini Flash antes de invocar al agente principal.
 *
 * Devuelve:
 *   'human_request' — el cliente quiere hablar con una persona (explícita o implícitamente)
 *   'frustrated'    — el cliente expresa frustración o percibe que no está siendo ayudado
 *   'none'          — mensaje normal; no se requiere escalada
 *
 * Diseño:
 *   - Llamada aislada a Gemini Flash (temperature 0, max 16 tokens)
 *   - Timeout propio de 2500 ms; en caso de error o timeout → 'none'
 *   - Acepta los últimos mensajes del cliente como contexto opcional para
 *     detectar frustración acumulada (no solo en el mensaje actual)
 *   - Nunca throws: cualquier fallo devuelve 'none' (fail-safe)
 */

const { GoogleGenAI } = require('@google/genai');
const log = require('./logger').createLogger('intentClassifier');

const CLASSIFIER_TIMEOUT_MS = 2500;
const VALID_RESULTS = new Set(['human_request', 'frustrated', 'none']);

/**
 * Construye el prompt de clasificación.
 * Si se pasan mensajes recientes se incluyen como contexto extra
 * para detectar frustración acumulada a lo largo de la conversación.
 *
 * @param {string}   message              - Último mensaje del cliente
 * @param {string[]} recentClientMessages - Mensajes anteriores del cliente (opcional, máx 3)
 */
function buildPrompt(message, recentClientMessages = []) {
    const context = recentClientMessages.length
        ? `\nMensajes anteriores del cliente (para detectar patrón de frustración):\n`
          + recentClientMessages.slice(-3).map((m) => `- "${m}"`).join('\n')
          + '\n'
        : '';

    return `Eres un clasificador de intenciones para el chat de atención al cliente de una tienda de ropa.

Analiza el último mensaje del cliente y determina si expresa alguna de estas intenciones:

1. human_request — El cliente quiere hablar con una persona humana, asesor, vendedor o agente real.
   Señales: peticiones explícitas ("quiero hablar con alguien", "pásame con un asesor", "prefiero hablar con una persona") o implícitas ("necesito hablar con alguien de verdad", "que me llame alguien", "quiero atención personalizada").

2. frustrated — El cliente expresa frustración, insatisfacción o siente que no está siendo ayudado.
   Señales: "no me estás ayudando", "sigues sin responder lo que pregunto", "no entiendes", "esto no sirve", "qué pésima atención", "llevas varios mensajes y no me resuelves nada", preguntas repetidas con irritación.

3. none — Consulta normal sobre productos, precios, cotizaciones, saludos u otras conversaciones que no requieren escalada.
${context}
Último mensaje del cliente: "${message}"

Responde ÚNICAMENTE con una de estas tres palabras exactas: human_request, frustrated, none`;
}

/**
 * Clasifica la intención de escalada en el mensaje del cliente.
 *
 * @param {string}   message              - Último mensaje del cliente
 * @param {string[]} [recentClientMessages=[]] - Mensajes previos del cliente (contexto)
 * @returns {Promise<'human_request'|'frustrated'|'none'>}
 */
async function classifyHandoffIntent(message, recentClientMessages = []) {
    if (!message || !message.trim()) return 'none';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return 'none';

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn({ message: message.slice(0, 80) }, 'intentClassifier: timeout — fallback none');
            resolve('none');
        }, CLASSIFIER_TIMEOUT_MS);
    });

    const call = (async () => {
        try {
            const client = new GoogleGenAI({ apiKey });
            const res = await client.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: buildPrompt(message, recentClientMessages) }] }],
                config: { temperature: 0, maxOutputTokens: 16 },
            });
            const raw = (res?.text || '').trim().toLowerCase().split(/\s/)[0];
            if (!VALID_RESULTS.has(raw)) {
                log.warn({ raw, message: message.slice(0, 80) }, 'intentClassifier: respuesta inesperada — fallback none');
                return 'none';
            }
            if (raw !== 'none') {
                log.info({ intent: raw, message: message.slice(0, 80) }, 'intentClassifier: intención detectada');
            }
            return raw;
        } catch (err) {
            log.warn({ err: err.message, message: message.slice(0, 80) }, 'intentClassifier: error — fallback none');
            return 'none';
        }
    })();

    const result = await Promise.race([call, timeout]);
    clearTimeout(timer);
    return result;
}

module.exports = { classifyHandoffIntent };

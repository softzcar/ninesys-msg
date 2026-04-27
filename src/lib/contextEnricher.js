/**
 * contextEnricher.js
 *
 * Enriquece el system prompt de Gemini con contexto dinámico justo antes de
 * cada llamada. Así el agente puede responder preguntas sobre horario, precios,
 * estado de pedidos, etc. con datos en tiempo real sin necesidad de tools/RAG.
 *
 * Patrón de uso en aiService.generateReply():
 *   const ctx = await enrichContext(idEmpresa, incomingText);
 *   // ctx es un string (puede ser vacío). Se concatena al system prompt.
 *
 * Diseño de capas:
 *   - detectIntent(text)        → Set de intenciones detectadas por keyword
 *   - fetchSchedule(idEmpresa)  → texto formateado del horario (siempre se
 *                                  inyecta: es pequeño y muy útil)
 *   - [futuro] fetchCatalog     → precios/catálogo bajo demanda
 *   - [futuro] fetchOrders      → estado de pedidos bajo demanda
 *   - [futuro] fetchBalance     → saldo del cliente bajo demanda
 *
 * Regla de inyección:
 *   El horario se inyecta siempre (≈30 tokens, alto impacto).
 *   Los demás se inyectan solo si detectIntent() lo indica, para no inflar
 *   el prompt con datos irrelevantes en cada conversación.
 */

const businessHoursClient = require('./businessHoursClient');
const businessHours = require('./businessHours');
const catalogClient = require('./catalogClient');
const log = require('./logger').createLogger('contextEnricher');

// ---------------------------------------------------------------------------
// Detección de intención por keywords
// ---------------------------------------------------------------------------

const INTENT_PATTERNS = {
    horario: [
        /\bhorario\b/i,
        /\babierto\b/i,
        /\babiertos?\b/i,
        /\batienden?\b/i,
        /\bcierran?\b/i,
        /\bhoras?\s+de\s+(atenci[oó]n|trabajo|oficina)\b/i,
        /\bestan?\s+(abierto|disponible)\b/i,
        /\bcuando\s+(abren?|atienden?|trabajan?)\b/i,
        /\bdisponible\b/i,
    ],
    // Placeholders para próximas fases — no activos aún
    precio: [
        /\bprecio\b/i,
        /\bcu[aá]nto\s+(cuesta|vale|sale|cuestan|valen|salen)\b/i,
        /\bcat[aá]logo\b/i,
        /\bproductos?\b/i,
        /\bprendas?\b/i,
        /\b(camisa|camiseta|franela|pantalon|uniforme|remera|camisas|camisetas|franelas|pantalones|uniformes|remeras)\b/i,
        /\boferta\b/i,
        /\bcosto\b/i,
        /\bvalu\b/i,
    ],
    pedido: [
        /\bpedido\b/i, /\borden\b/i, /\benv[ií]o\b/i,
        /\bcu[aá]ndo\s+(llega|viene|estar[aá])\b/i,
        /\bestado\s+de\b/i, /\bdónde\s+est[aá]\b/i,
    ],
    cuenta: [
        /\bdeuda\b/i, /\bsaldo\b/i, /\bcuenta\b/i,
        /\bcuánto\s+(debo|me\s+falta|queda)\b/i,
        /\bpagar?\b/i, /\bfactura\b/i,
    ],
};

/**
 * Detecta intenciones presentes en el texto del usuario.
 * @param {string} text
 * @returns {Set<string>}
 */
function detectIntent(text) {
    const found = new Set();
    if (!text) {
        log.debug('detectIntent: texto vacío');
        return found;
    }
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
        for (const re of patterns) {
            if (re.test(text)) {
                log.debug({ intent, pattern: re.toString(), text }, 'detectIntent: coincidencia encontrada');
                found.add(intent);
                break;
            }
        }
    }
    return found;
}

// ---------------------------------------------------------------------------
// Formateadores de contexto
// ---------------------------------------------------------------------------

const DIAS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/**
 * Convierte un decimal de hora a "HH:MM".
 * 8.5 → "08:30", 17 → "17:00"
 */
function decimalToHHMM(h) {
    const hh = Math.floor(h);
    const mm = Math.round((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Formatea el objeto horario_laboral como texto legible para Gemini.
 * Devuelve null si el horario no se pudo obtener.
 *
 * @param {number} idEmpresa
 * @returns {Promise<string|null>}
 */
async function fetchSchedule(idEmpresa) {
    let hours;
    try {
        log.debug({ idEmpresa }, 'fetchSchedule: solicitando a businessHoursClient');
        hours = await businessHoursClient.fetchBusinessHours(idEmpresa);
        log.debug({ idEmpresa, hours }, 'fetchSchedule: respuesta recibida');
    } catch (err) {
        log.error({
            err: err.message,
            code: err.code,
            errno: err.errno,
            idEmpresa
        }, 'fetchSchedule: error al obtener horario');
        return null;
    }
    if (!hours) {
        log.warn({ idEmpresa }, 'fetchSchedule: businessHoursClient devolvió null/falsy');
        return null;
    }

    // Días laborales
    const diasStr = (hours.diasLaborales || [])
        .map(Number)
        .filter((d) => d >= 1 && d <= 7)
        .sort((a, b) => a - b)
        .map((d) => DIAS[d])
        .join(', ');

    // Tramos horarios
    const tramos = [];
    const { horaInicioManana: hIM, horaFinManana: hFM,
            horaInicioTarde: hIT, horaFinTarde: hFT } = hours;
    if (hIM != null && hIM !== '' && hFM != null && hFM !== '') {
        tramos.push(`${decimalToHHMM(Number(hIM))}–${decimalToHHMM(Number(hFM))}`);
    }
    if (hIT != null && hIT !== '' && hFT != null && hFT !== '') {
        tramos.push(`${decimalToHHMM(Number(hIT))}–${decimalToHHMM(Number(hFT))}`);
    }

    const tramosStr = tramos.length ? tramos.join(' y ') : 'horario no especificado';
    const diasLabel = diasStr || 'días no especificados';

    // ¿Estamos dentro del horario ahora mismo?
    const now = new Date();
    const estado = businessHours.isWithinBusinessHours(now, hours)
        ? 'SÍ están atendiendo en este momento'
        : 'NO están atendiendo en este momento';

    return `Horario de atención: ${diasLabel} de ${tramosStr}. Estado actual: ${estado}.`;
}

// ---------------------------------------------------------------------------
// Punto de entrada público
// ---------------------------------------------------------------------------

/**
 * Formatea el catálogo de productos para inyectar en el prompt.
 * Retorna null si no hay productos o hay error.
 *
 * @param {number} idEmpresa
 * @param {string} searchTerm
 * @returns {Promise<string|null>}
 */
async function fetchProducts(idEmpresa, searchTerm) {
    if (!searchTerm || searchTerm.length < 2) return null;

    // Extrae palabras clave del mensaje (palabras con 3+ caracteres, excluyendo preposiciones)
    const stopwords = new Set([
        'el', 'la', 'de', 'para', 'por', 'con', 'sin', 'que', 'pero', 'este',
        'este', 'esa', 'ese', 'este', 'dame', 'deme', 'quiero', 'necesito',
        'tengo', 'busco', 'precio', 'cual', 'cuanto', 'cuantos', 'cuales',
        'como', 'donde', 'cuando', 'pues', 'porque', 'es',
    ]);
    const keywords = searchTerm
        .toLowerCase()
        .replace(/[¿?¡!.,;:—-]/g, ' ')  // Limpia puntuación
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopwords.has(w))
        .join(' ');

    const finalSearch = keywords.trim() || searchTerm;

    try {
        log.debug({ idEmpresa, originalTerm: searchTerm, finalSearch }, 'fetchProducts: buscando');
        const catalog = await catalogClient.fetchCatalog(idEmpresa, finalSearch);
        if (!catalog || !catalog.products || !catalog.products.length) {
            log.debug({ idEmpresa, finalSearch, found: catalog?.products?.length || 0 }, 'fetchProducts: sin resultados');
            return null;
        }
        log.info({ idEmpresa, finalSearch, productCount: catalog.products.length }, 'fetchProducts: productos encontrados');

        const lines = ['Productos disponibles:'];
        for (const p of catalog.products.slice(0, 10)) { // Limitar a 10 para no inflar el prompt
            let line = `• ${p.name}`;
            if (p.is_design) {
                line += ' (diseño personalizado — solicita cotización)';
            } else if (p.price_min !== null) {
                if (p.price_max && p.price_max > p.price_min) {
                    line += ` — desde $${p.price_min.toFixed(2)} hasta $${p.price_max.toFixed(2)}`;
                } else {
                    line += ` — $${p.price_min.toFixed(2)}`;
                }
            }
            if (p.description) {
                line += ` (${p.description})`;
            }
            if (p.categories && p.categories.length) {
                line += ` [${p.categories.join(', ')}]`;
            }
            lines.push(line);
        }
        return lines.join('\n');
    } catch (err) {
        log.error({
            err: err.message,
            code: err.code,
            errno: err.errno,
            idEmpresa,
            searchTerm
        }, 'fetchProducts falló');
        return null;
    }
}

/**
 * Genera el bloque de contexto dinámico para inyectar en el system prompt.
 *
 * IMPORTANTE: Timeout de 3 segundos. Si ninesys-api tarda más,
 * retorna contexto vacío en lugar de bloquear la respuesta del agente.
 *
 * @param {number}  idEmpresa
 * @param {string}  [lastUserMessage]  - último mensaje del cliente (para detectIntent)
 * @returns {Promise<string>}          - texto a añadir al prompt (puede ser '')
 */
async function enrichContext(idEmpresa, lastUserMessage = '') {
    const startTime = Date.now();
    const sections = [];

    log.info({ idEmpresa, message: lastUserMessage }, 'enrichContext: INICIANDO');

    // Wrapper con timeout para schedule (15s para llamadas HTTP remotas)
    const schedulePromise = Promise.race([
        fetchSchedule(idEmpresa),
        new Promise((resolve) =>
            setTimeout(() => {
                log.warn({ idEmpresa }, 'enrichContext: timeout esperando schedule');
                resolve(null);
            }, 15000)
        ),
    ]);

    // El horario siempre se inyecta: es liviano y muy relevante.
    const schedule = await schedulePromise;
    if (schedule) {
        sections.push(schedule);
        log.debug({ idEmpresa, schedule }, 'contextEnricher: horario inyectado');
    } else {
        log.warn({ idEmpresa }, 'contextEnricher: no se obtuvo horario');
    }

    // Detectar intenciones y cargar contexto bajo demanda (con timeout)
    const intents = detectIntent(lastUserMessage);
    log.info({ idEmpresa, intents: Array.from(intents), message: lastUserMessage }, 'contextEnricher: detectIntent resultado');

    if (intents.has('precio')) {
        log.debug({ idEmpresa, message: lastUserMessage }, 'contextEnricher: intent precio detectada, obteniendo catálogo');
        const productsPromise = Promise.race([
            fetchProducts(idEmpresa, lastUserMessage),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando catálogo');
                    resolve(null);
                }, 15000)
            ),
        ]);
        const products = await productsPromise;
        if (products) {
            sections.push(products);
            log.debug({ idEmpresa, productLength: products.length }, 'contextEnricher: catálogo inyectado');
        } else {
            log.warn({ idEmpresa }, 'contextEnricher: no se obtuvo catálogo (null o timeout)');
        }
    }

    // Intenciones futuras (no activas aún)
    // if (intents.has('pedido')) sections.push(await fetchOrders(idEmpresa, clientPhone));
    // if (intents.has('cuenta')) sections.push(await fetchBalance(idEmpresa, clientPhone));

    const elapsed = Date.now() - startTime;
    log.info({ idEmpresa, sections: sections.length, elapsed }, 'enrichContext: COMPLETADO');

    if (!sections.length) {
        log.warn({ idEmpresa, elapsed }, 'enrichContext: retornando contexto vacío');
        return '';
    }

    const context = [
        '--- Contexto en tiempo real (usar para responder con precisión) ---',
        ...sections,
        '--- Fin del contexto en tiempo real ---',
    ].join('\n');

    log.info({ idEmpresa, length: context.length, elapsed }, 'enrichContext: contexto inyectado');
    return context;
}

module.exports = {
    enrichContext,
    // Expuestos para tests
    detectIntent,
    _fetchSchedule: fetchSchedule,
    _fetchProducts: fetchProducts,
    _decimalToHHMM: decimalToHHMM,
};

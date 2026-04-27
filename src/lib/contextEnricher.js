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
 * Estrategia:
 *   - fetchSchedule(idEmpresa)  → horario (siempre se inyecta)
 *   - fetchProducts(idEmpresa, incomingText) → catálogo/precios (siempre se
 *                                  intenta, pero solo se inyecta si hay resultados)
 *
 * Regla de inyección:
 *   El horario se inyecta siempre (≈30 tokens, alto impacto).
 *   Los productos se buscan siempre y se inyectan si hay resultados.
 *   Si no hay resultados, simplemente no contamina el contexto.
 */

const businessHoursClient = require('./businessHoursClient');
const businessHours = require('./businessHours');
const catalogClient = require('./catalogClient');
const log = require('./logger').createLogger('contextEnricher');


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
        // Artículos y preposiciones
        'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
        'de', 'para', 'por', 'con', 'sin', 'que', 'pero', 'este',
        'esa', 'ese', 'aquel', 'aquella', 'aquello',
        // Verbos conjugados (muy comunes)
        'dame', 'deme', 'quiero', 'necesito', 'tengo', 'busco',
        'cuesta', 'cuestan', 'vale', 'valen', 'sale', 'salen',
        'es', 'son', 'soy', 'eres', 'somos', 'sois',
        // Palabras clave de búsqueda (con y sin acentos)
        'precio', 'catalogo', 'producto',
        'cual', 'cuál', 'cuanto', 'cuánto', 'cuantos', 'cuántos',
        'cuales', 'cuáles', 'cuanta', 'cuánta', 'cuantas', 'cuántas',
        'como', 'cómo', 'donde', 'dónde', 'cuando', 'cuándo', 'pues', 'porque', 'porqué', 'bien',
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
            } else if (p.prices && p.prices.length > 0) {
                // Formatear todos los precios con sus descripciones
                const priceStrings = p.prices.map(
                    pr => `$${pr.price.toFixed(2)} (${pr.descripcion})`
                );
                line += ` — ${priceStrings.join(', ')}`;
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
 * Estrategia: inyectar siempre horario + intentar buscar productos sin detectIntent().
 * Si no hay resultados, simplemente no se inyecta nada (no contamina contexto).
 *
 * @param {number}  idEmpresa
 * @param {string}  [lastUserMessage]  - último mensaje del cliente (para búsqueda de productos)
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
        log.debug({ idEmpresa }, 'contextEnricher: horario inyectado');
    } else {
        log.warn({ idEmpresa }, 'contextEnricher: no se obtuvo horario');
    }

    // Siempre intentar buscar productos (sin detectIntent). Si no hay resultados,
    // fetchProducts devuelve null y simplemente no se inyecta nada.
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
    }

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
    _fetchSchedule: fetchSchedule,
    _fetchProducts: fetchProducts,
    _decimalToHHMM: decimalToHHMM,
};

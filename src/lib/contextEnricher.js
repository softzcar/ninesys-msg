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

const { GoogleGenAI } = require('@google/genai');
const businessHoursClient = require('./businessHoursClient');
const businessHours = require('./businessHours');
const catalogClient = require('./catalogClient');
const telasClient = require('./telasClient');
const galleryClient = require('./galleryClient');
const log = require('./logger').createLogger('contextEnricher');

const INTENT_TIMEOUT_MS = 3000;

const INTENT_PROMPT = `Eres un asistente de una tienda de ropa personalizada en Venezuela.

Del siguiente mensaje de un cliente extrae el tipo de prenda o producto mencionado y normalízalo al término estándar en español. Responde SOLO con el término normalizado en singular y minúsculas. Si no hay producto, responde: null

Reglas de normalización (sinónimos → término nativo del catálogo):
- camiseta, remera, playera, polera, camibuso, t-shirt, swater, suéter, sweter, chemise, blusa → franela
- gorra, cachucha, jockey, cap, sombrero → gorra
- buzo, sudadera, hoodie, capota, chompa, sweatshirt → buzo
- jean, pantalón, pants, pantalones → pantalón
- jogger, jogging → jogger
- bermuda, short, pantaloneta → bermuda
- chaqueta, jacket, chamarra → chaqueta
- chaleco, vest → chaleco
- camisa, shirt → camisa
- polo, camiseta polo → polo

Ejemplos de respuesta esperada:
"franela" → franela
"franelas sublimadas" → franela
"camiseta" → franela
"swater" → franela
"tienen remeras?" → franela
"cuanto salen las camisetas" → franela
"me interesan los buzos con logo" → buzo
"kiero vr los poleras" → franela
"joggers" → jogger
"bermuda" → bermuda
"gorras personalizadas" → gorra
"cachucha bordada" → gorra
"mas modelos" → null
"hola buenas" → null
"gracias" → null
"q tal les quedo el pedido" → null
"cuando me entregan" → null

Mensaje del cliente: `;

/**
 * Usa Gemini para detectar si el mensaje es una búsqueda de productos
 * y extrae el término de búsqueda óptimo.
 * Retorna el término de búsqueda (string) o null si no es una búsqueda.
 */
async function extractProductSearch(message) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn({ message }, 'extractProductSearch: timeout');
            resolve(null);
        }, INTENT_TIMEOUT_MS);
    });

    const call = (async () => {
        try {
            const client = new GoogleGenAI({ apiKey });
            const res = await client.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: INTENT_PROMPT + `"${message}"` }] }],
                config: { temperature: 0, maxOutputTokens: 128 },
            });
            const raw = (res?.text || '').trim().toLowerCase();
            if (!raw || raw === 'null') return null;
            return raw;
        } catch (err) {
            log.warn({ err: err.message, message }, 'extractProductSearch: falló (no crítico)');
            return null;
        }
    })();

    const result = await Promise.race([call, timeout]);
    clearTimeout(timer);
    return result;
}


// ---------------------------------------------------------------------------
// Detección de intención de acción (rule-based, síncrona, sin latencia)
// ---------------------------------------------------------------------------

// Galería: el cliente quiere VER imágenes / modelos
const GALLERY_RE = /foto|imagen|fotos|imágenes|galería|galeria|muestrame|muéstrame|(ver|mostrar|muestra).{0,30}(model|diseño|estilo|ejemplo)|model.{0,30}(ver|mostrar|muestra)|otro modelo|otros modelos/i;
// Presupuesto: el cliente quiere cotizar / pedir
const PRESUPUESTO_RE = /presupuesto|cotizaci|cotizar/i;

/**
 * Clasifica la intención de acción del mensaje sin llamar a Gemini.
 * @returns {'gallery'|'presupuesto'|'catalog'}
 */
function detectActionIntent(message) {
    if (!message) return 'catalog';
    if (PRESUPUESTO_RE.test(message)) return 'presupuesto';
    if (GALLERY_RE.test(message)) return 'gallery';
    return 'catalog';
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
// Telas disponibles
// ---------------------------------------------------------------------------

/**
 * Obtiene el catálogo de telas con su _id y lo formatea como texto para
 * que la IA use el _id (no el nombre) al completar el marker PRESUPUESTO_DATA.
 *
 * @param {number} idEmpresa
 * @returns {Promise<string|null>}
 */
async function fetchTelasContext(idEmpresa) {
    try {
        const telas = await telasClient.fetchTelasArray(idEmpresa);
        if (!telas.length) return null;
        const lines = ['Telas disponibles (usar el _id numérico en el campo "tela" del bloque PRESUPUESTO_DATA, nunca el nombre):'];
        for (const t of telas) {
            lines.push(`• _id:${t._id} — ${t.nombre}`);
        }
        return lines.join('\n');
    } catch (err) {
        log.warn({ err: err.message, idEmpresa }, 'fetchTelasContext: falló (no crítico)');
        return null;
    }
}

// ---------------------------------------------------------------------------
// Galería de imágenes — carpetas pre-clasificadas por el administrador
// ---------------------------------------------------------------------------

// Mapa url → productTerm para recuperar el término cuando el cliente pide "otra imagen"
// sin mencionar el producto (su mensaje genera resolvedProductTerm=null).
const urlToGalleryTerm = new Map();

/**
 * Devuelve la siguiente URL no enviada para el producto dado.
 * Las imágenes vienen de gallery/{idEmpresa}/{productTerm}/ en el CDN.
 * El administrador sube ahí las fotos pre-clasificadas.
 *
 * @param {number}   idEmpresa
 * @param {string}   productTerm  - término normalizado (ej: "camiseta")
 * @param {string[]} excludeUrls  - URLs ya enviadas en esta conversación
 * @returns {Promise<string|null>}
 */
async function fetchGallery(idEmpresa, productTerm, excludeUrls = []) {
    if (!productTerm || productTerm.length < 2) return null;
    try {
        const images = await galleryClient.listImages(idEmpresa, productTerm);
        if (!images.length) {
            log.info({ idEmpresa, productTerm }, 'fetchGallery: carpeta vacía o inexistente');
            return null;
        }

        const next = images.find((u) => !excludeUrls.includes(u));
        if (!next) {
            log.info({ idEmpresa, productTerm, shown: excludeUrls.length }, 'fetchGallery: todas las imágenes ya fueron enviadas');
            return null;
        }

        // Registrar qué producto originó esta URL (para continuación de galería).
        urlToGalleryTerm.set(next, productTerm);

        const shown = excludeUrls.filter((u) => images.includes(u)).length;
        const remaining = images.length - shown - 1; // pendientes DESPUÉS de enviar esta
        log.info({ idEmpresa, productTerm, url: next, total: images.length, shown, remaining }, 'fetchGallery: imagen seleccionada');
        const afterNote = remaining > 0
            ? `Después de esta quedan ${remaining} imagen(es) más sin mostrar.`
            : `Esta es la última imagen de "${productTerm}" disponible en la galería.`;
        return [
            `=== INSTRUCCIÓN OBLIGATORIA DE IMAGEN ===`,
            `Galería "${productTerm}": ${images.length} imagen(es) en total, ${shown} ya mostrada(s).`,
            `URL a enviar: ${next}`,
            `ACCIÓN REQUERIDA: (1) Escribe un texto breve de presentación (ej: "¡Aquí te muestro un modelo de chaqueta!") y (2) llama a la función send_gallery_image con esa URL exacta.`,
            `Si la función no está disponible, incluye [IMG:${next}] en tu respuesta como alternativa.`,
            afterNote,
            `NUNCA digas "es el único modelo que tenemos" — el catálogo puede tener más productos aunque la galería tenga ${images.length} foto(s).`,
            `=== FIN INSTRUCCIÓN IMAGEN ===`,
        ].join('\n');
    } catch (err) {
        log.warn({ err: err.message, idEmpresa, productTerm }, 'fetchGallery: falló (no crítico)');
        return null;
    }
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

    try {
        log.info({ idEmpresa, finalSearch: searchTerm }, 'fetchProducts: buscando');
        const catalog = await catalogClient.fetchCatalog(idEmpresa, searchTerm);
        if (!catalog || !catalog.products || !catalog.products.length) {
            log.info({ idEmpresa, finalSearch: searchTerm, found: catalog?.products?.length || 0 }, 'fetchProducts: sin resultados');
            return null;
        }
        const categoryTerm = catalog.products[0]?.categories?.[0]?.toLowerCase().trim() || null;
        log.info({ idEmpresa, finalSearch: searchTerm, productCount: catalog.products.length, categoryTerm }, 'fetchProducts: productos encontrados');

        const lines = [
            'Productos encontrados (en submit_presupuesto: "cod"=id producto, "precio"=precio UNITARIO del tramo que corresponda — NO es el total, es precio por unidad):',
        ];
        for (const p of catalog.products.slice(0, 10)) {
            let line = `• ${p.name} [cod:${p.id}][idCat:${p.category_id || 0}]`;
            if (p.is_design) {
                line += ' (diseño personalizado — solicita cotización)';
            } else if (p.prices && p.prices.length > 0) {
                const priceStrings = p.prices.map((pr, i) => {
                    const thisQty = parseInt((pr.descripcion || '').match(/\d+/)?.[0] || '1', 10);
                    const next = p.prices[i + 1];
                    const nextQty = next ? parseInt((next.descripcion || '').match(/\d+/)?.[0] || '99999', 10) : null;
                    const range = nextQty ? `${thisQty}–${nextQty - 1} uds` : `${thisQty}+ uds`;
                    return `$${pr.price.toFixed(2)}/unid (${range})`;
                });
                line += ` — ${priceStrings.join(', ')}`;
            }
            if (p.description) {
                line += ` (${p.description})`;
            }
            if (p.categories && p.categories.length) {
                line += ` [cats:${p.categories.join(', ')}]`;
            }
            lines.push(line);
        }
        return { text: lines.join('\n'), categoryTerm };
    } catch (err) {
        log.error({
            err: err.message,
            code: err.code,
            errno: err.errno,
            idEmpresa,
            finalSearch: searchTerm
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
async function enrichContext(idEmpresa, lastUserMessage = '', { excludeGalleryUrls = [] } = {}) {
    const startTime = Date.now();
    const sections = [];

    const actionIntent = detectActionIntent(lastUserMessage);
    const isGalleryRequest = actionIntent === 'gallery' || (excludeGalleryUrls.length > 0 && !lastUserMessage);

    log.info({ idEmpresa, message: lastUserMessage, intent: actionIntent }, 'enrichContext: INICIANDO');

    // Fase 1 — todo lo independiente corre en paralelo.
    // Schedule y telas se saltan en solicitudes de galería: son irrelevantes y
    // solo añaden ruido que interfiere con la instrucción de imagen.
    const [resolvedProductTerm, schedule, telas] = await Promise.all([
        // Extraer término de producto del mensaje (Gemini Flash, temperatura 0)
        (lastUserMessage && lastUserMessage.length >= 2)
            ? Promise.race([
                extractProductSearch(lastUserMessage),
                new Promise((r) => setTimeout(() => r(null), INTENT_TIMEOUT_MS + 500)),
            ])
            : Promise.resolve(null),

        // Horario de atención — omitir si el cliente solo pide imágenes
        isGalleryRequest
            ? Promise.resolve(null)
            : Promise.race([
                fetchSchedule(idEmpresa),
                new Promise((resolve) =>
                    setTimeout(() => {
                        log.warn({ idEmpresa }, 'enrichContext: timeout esperando schedule');
                        resolve(null);
                    }, 15000)
                ),
            ]),

        // Catálogo de telas — omitir si el cliente solo pide imágenes
        isGalleryRequest
            ? Promise.resolve(null)
            : Promise.race([
                fetchTelasContext(idEmpresa),
                new Promise((resolve) =>
                    setTimeout(() => {
                        log.warn({ idEmpresa }, 'enrichContext: timeout esperando telas');
                        resolve(null);
                    }, 10000)
                ),
            ]),
    ]);

    if (schedule) {
        sections.push(schedule);
        log.debug({ idEmpresa }, 'contextEnricher: horario inyectado');
    } else if (!isGalleryRequest) {
        log.warn({ idEmpresa }, 'contextEnricher: no se obtuvo horario');
    }
    if (telas) {
        sections.push(telas);
        log.debug({ idEmpresa }, 'contextEnricher: telas inyectadas');
    }

    // La galería solo se busca cuando el cliente explícitamente pide imágenes (intent=gallery)
    // o cuando ya se envió una imagen antes (continuación de sesión de galería).
    // Si la intención es presupuesto o consulta de catálogo, NO inyectar galería para que
    // Gemini no llame a send_gallery_image cuando el cliente quiere comprar.
    const wantsGallery = actionIntent === 'gallery' || excludeGalleryUrls.length > 0;

    // Recuperar término de producto para continuar una sesión de galería anterior
    // (ej: cliente dice "muéstrame otro" sin mencionar el producto).
    let galleryProductTerm = wantsGallery ? resolvedProductTerm : null;
    if (!galleryProductTerm && excludeGalleryUrls.length > 0) {
        for (const url of [...excludeGalleryUrls].reverse()) {
            const term = urlToGalleryTerm.get(url);
            if (term) {
                galleryProductTerm = term;
                log.info({ idEmpresa, galleryProductTerm, excluded: excludeGalleryUrls.length },
                    'enrichContext: término recuperado de urlToGalleryTerm para continuación de galería');
                break;
            }
        }
    }

    // Fase 2a — catálogo (secuencial: necesitamos categoryTerm antes de buscar galería)
    const productResult = resolvedProductTerm
        ? await Promise.race([
            fetchProducts(idEmpresa, resolvedProductTerm),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando catálogo');
                    resolve(null);
                }, 15000)
            ),
        ])
        : null;

    if (productResult?.text) {
        sections.push(productResult.text);
        log.debug({ idEmpresa }, 'contextEnricher: catálogo inyectado');
    }

    // Fase 2b — galería: usar categoryTerm del catálogo como fuente de verdad.
    // Ej: usuario dice "camiseta" → extractProductSearch → "franela" → fetchProducts → categoryTerm="franelas"
    // → fetchGallery busca carpeta "franelas" en CDN, no "camiseta".
    const resolvedGalleryTerm = wantsGallery
        ? (productResult?.categoryTerm || galleryProductTerm)
        : null;

    const gallery = resolvedGalleryTerm
        ? await Promise.race([
            fetchGallery(idEmpresa, resolvedGalleryTerm, excludeGalleryUrls),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando galería');
                    resolve(null);
                }, 8000)
            ),
        ])
        : null;

    if (gallery) {
        sections.push(gallery);
        log.debug({ idEmpresa }, 'contextEnricher: galería inyectada');
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
    _fetchSchedule: fetchSchedule,
    _fetchProducts: fetchProducts,
    _fetchGallery: fetchGallery,
    _decimalToHHMM: decimalToHHMM,
    _urlToGalleryTerm: urlToGalleryTerm,
};

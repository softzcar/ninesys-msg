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


// Cache de resolución término → carpeta CDN (para no repetir la llamada Gemini)
// `${idEmpresa}:${term}` → { folder: string, fetchedAt: number }
const galleryFolderResolutionCache = new Map();
const FOLDER_RESOLUTION_TTL_MS = 30 * 60 * 1000;

/**
 * Usa Gemini Flash para elegir la carpeta CDN más apropiada para un término de producto.
 * Devuelve el nombre de la carpeta o null si ninguna coincide.
 */
async function resolveGalleryFolder(term, availableFolders) {
    if (!availableFolders.length) return null;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const { GoogleGenAI } = require('@google/genai');
    const client = new GoogleGenAI({ apiKey });
    const prompt = `Tienes estas carpetas de galería disponibles: [${availableFolders.join(', ')}]
El cliente busca imágenes de: "${term}"
¿Cuál carpeta corresponde mejor? Responde SOLO con el nombre exacto de la carpeta. Si ninguna corresponde, responde: null`;

    try {
        const res = await client.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { temperature: 0, maxOutputTokens: 32 },
        });
        const answer = (res?.text || '').trim().toLowerCase();
        if (!answer || answer === 'null') return null;
        // Verificar que la respuesta sea una carpeta real
        const match = availableFolders.find((f) => f.toLowerCase() === answer);
        log.info({ term, availableFolders, answer, match }, 'resolveGalleryFolder: resultado Gemini');
        return match || null;
    } catch (err) {
        log.warn({ err: err.message, term }, 'resolveGalleryFolder: falló');
        return null;
    }
}

// ---------------------------------------------------------------------------
// Detección de intención de acción (rule-based, síncrona, sin latencia)
// ---------------------------------------------------------------------------

// Galería: el cliente quiere VER imágenes / modelos
const GALLERY_RE = /foto|imagen|fotos|imágenes|galería|galeria|muestrame|muéstrame|quier[oa]\s+ver|quiero\s+ver|ver\s+los?\s+modelos?|ver\s+los?\s+diseños?|(ver|mostrar|muestra).{0,30}(model|diseño|estilo|ejemplo|foto)|model.{0,30}(ver|mostrar|muestra)|otro modelo|otros modelos/i;
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
 * Devuelve la instrucción de galería para Gemini con la siguiente imagen no enviada.
 *
 * Estrategia de 2 pasos:
 *   1. Prueba el término directo (el CDN ya hace prefix matching chaqueta↔chaquetas).
 *   2. Si vacío: lista todas las carpetas disponibles y usa Gemini Flash para elegir
 *      la carpeta semánticamente más cercana (franela → camiseta, etc.).
 *      El resultado se cachea 30 min para no repetir la llamada.
 *
 * @param {number}   idEmpresa
 * @param {string}   productTerm  - término normalizado (ej: "franela", "chaqueta")
 * @param {string[]} excludeUrls  - URLs ya enviadas en esta conversación
 * @returns {Promise<string|null>}
 */
async function fetchGallery(idEmpresa, productTerm, excludeUrls = []) {
    if (!productTerm || productTerm.length < 2) return null;

    // Paso 1: intento directo (CDN maneja singular/plural por prefix matching)
    let images = await galleryClient.listImages(idEmpresa, productTerm).catch(() => []);

    // Paso 2: si vacío, buscar la carpeta por similitud semántica via Gemini Flash
    if (!images.length) {
        const cacheKey = `${idEmpresa}:${productTerm}`;
        const cached = galleryFolderResolutionCache.get(cacheKey);
        let resolvedFolder = cached && Date.now() - cached.fetchedAt < FOLDER_RESOLUTION_TTL_MS
            ? cached.folder
            : null;

        if (!resolvedFolder) {
            const folders = await galleryClient.listFolders(idEmpresa).catch(() => []);
            if (folders.length) {
                resolvedFolder = await resolveGalleryFolder(productTerm, folders);
                galleryFolderResolutionCache.set(cacheKey, { folder: resolvedFolder, fetchedAt: Date.now() });
            }
        }

        if (resolvedFolder && resolvedFolder !== productTerm) {
            log.info({ idEmpresa, productTerm, resolvedFolder }, 'fetchGallery: carpeta resuelta por Gemini');
            images = await galleryClient.listImages(idEmpresa, resolvedFolder).catch(() => []);
            if (images.length) productTerm = resolvedFolder; // usar el término real para logs/continuación
        }
    }

    if (!images.length) {
        log.info({ idEmpresa, productTerm }, 'fetchGallery: carpeta vacía o inexistente');
        return null;
    }

    const next = images.find((u) => !excludeUrls.includes(u));
    if (!next) {
        log.info({ idEmpresa, productTerm, shown: excludeUrls.length }, 'fetchGallery: todas las imágenes ya fueron enviadas');
        return null;
    }

    urlToGalleryTerm.set(next, productTerm);

    const shown = excludeUrls.filter((u) => images.includes(u)).length;
    const remaining = images.length - shown - 1;
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
            '⚠️ INSTRUCCIÓN INTERNA — NO MOSTRAR AL CLIENTE: Los marcadores [cod:X][idCat:X] son referencias para la función submit_presupuesto. Jamás los incluyas en tu respuesta al cliente.',
            'Productos disponibles (precios UNITARIOS por tramo de cantidad):',
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

    // Fase 2b — galería: fetchGallery resuelve automáticamente el nombre de carpeta CDN.
    // Paso 1: intento directo (CDN hace prefix matching). Paso 2 si vacío: lista carpetas
    // + Gemini Flash elige la más cercana semánticamente (franela → camiseta, etc.).
    const gallery = wantsGallery && galleryProductTerm
        ? await Promise.race([
            fetchGallery(idEmpresa, galleryProductTerm, excludeGalleryUrls),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando galería');
                    resolve(null);
                }, 12000)
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

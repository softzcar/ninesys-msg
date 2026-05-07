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

const INTENT_PROMPT = `Eres un asistente de una tienda de ropa personalizada.

Del siguiente mensaje de un cliente extrae el nombre del producto de ropa o tela que se menciona. Responde SOLO con el nombre del producto en singular y minúsculas, sin ningún texto adicional. Si no hay producto, responde solo la palabra: null

Ejemplos:
"franela" → franela
"joggers" → jogger
"vender joggers" → jogger
"tienen remeras?" → remera
"cuanto salen las camisetas" → camiseta
"me interesan los buzos con logo" → buzo
"kiero vr los poleras" → polera
"bermuda" → bermuda
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
// Galería de imágenes — selección por Gemini Vision
// ---------------------------------------------------------------------------

/**
 * Descarga hasta 12 imágenes en paralelo y usa Gemini Vision para seleccionar
 * las relevantes al término de búsqueda. Devuelve URLs de las coincidentes (máx 4).
 */
async function visionSelectImages(imageUrls, productTerm) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !imageUrls.length) return [];

    const axios = require('axios');
    const candidates = imageUrls.slice(0, 12);

    const downloaded = await Promise.all(
        candidates.map(async (url, i) => {
            try {
                const res = await axios.get(url, {
                    responseType: 'arraybuffer',
                    timeout: 5000,
                    maxContentLength: 5 * 1024 * 1024,
                });
                const mimeType = (res.headers['content-type'] || 'image/png').split(';')[0].trim();
                const data = Buffer.from(res.data).toString('base64');
                return { index: i + 1, url, mimeType, data };
            } catch {
                return null;
            }
        })
    );

    const valid = downloaded.filter(Boolean);
    if (!valid.length) return [];

    const parts = [
        {
            text: `Eres un clasificador de imágenes de productos de ropa y accesorios. El cliente busca: "${productTerm}".
Examina cada imagen numerada e indica cuáles muestran ese tipo de producto o prenda.
Responde SOLO con los números relevantes separados por coma (ej: 1,3). Si ninguna coincide, responde: ninguna`,
        },
    ];
    for (const img of valid) {
        parts.push({ text: `Imagen ${img.index}:` });
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    try {
        const client = new GoogleGenAI({ apiKey });
        const res = await client.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts }],
            config: { temperature: 0, maxOutputTokens: 32 },
        });
        const raw = (res?.text || '').trim().toLowerCase();
        log.info({ productTerm, raw, total: valid.length }, 'visionSelectImages: resultado Gemini');

        if (!raw || raw === 'ninguna') return [];

        return raw
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n) && n >= 1 && n <= valid.length)
            .slice(0, 4)
            .map((i) => valid[i - 1].url);
    } catch (err) {
        log.warn({ err: err.message, productTerm }, 'visionSelectImages: falló (no crítico)');
        return [];
    }
}

/**
 * Selecciona imágenes relevantes del directorio de la empresa usando Vision.
 * Recibe la lista ya obtenida (evita doble llamada al CDN).
 */
async function fetchGallery(allImageUrls, productTerm, idEmpresa) {
    if (!productTerm || productTerm.length < 2 || !allImageUrls.length) return null;
    try {
        const selected = await visionSelectImages(allImageUrls, productTerm);
        if (!selected.length) {
            log.info({ idEmpresa, productTerm }, 'fetchGallery: Vision no encontró imágenes relevantes');
            return null;
        }
        const lines = [
            `Galería de imágenes disponibles para "${productTerm}" (usa [IMG:url1|url2] para mostrar hasta 4 cuando el cliente pida ver modelos o fotos):`,
        ];
        for (const url of selected) lines.push(`• ${url}`);
        return lines.join('\n');
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
        log.info({ idEmpresa, finalSearch: searchTerm, productCount: catalog.products.length }, 'fetchProducts: productos encontrados');

        const lines = [
            'Productos encontrados (incluir en PRESUPUESTO_DATA: usa "cod" = id del producto, "precio" = precio según cantidad pedida):',
        ];
        for (const p of catalog.products.slice(0, 10)) {
            let line = `• ${p.name} [cod:${p.id}][idCat:${p.category_id || 0}]`;
            if (p.is_design) {
                line += ' (diseño personalizado — solicita cotización)';
            } else if (p.prices && p.prices.length > 0) {
                const priceStrings = p.prices.map(
                    pr => `$${pr.price.toFixed(2)} (${pr.descripcion})`
                );
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
        return lines.join('\n');
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
async function enrichContext(idEmpresa, lastUserMessage = '') {
    const startTime = Date.now();
    const sections = [];

    log.info({ idEmpresa, message: lastUserMessage }, 'enrichContext: INICIANDO');

    // Fase 1 — todo lo independiente corre en paralelo:
    //   horario, telas, listado de imágenes del CDN, extracción de término de producto.
    const [resolvedProductTerm, schedule, telas, allImageUrls] = await Promise.all([
        // Extraer término de producto del mensaje (Gemini Flash, texto)
        (lastUserMessage && lastUserMessage.length >= 2)
            ? Promise.race([
                extractProductSearch(lastUserMessage),
                new Promise((r) => setTimeout(() => r(null), INTENT_TIMEOUT_MS + 500)),
            ])
            : Promise.resolve(null),

        // Horario de atención
        Promise.race([
            fetchSchedule(idEmpresa),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando schedule');
                    resolve(null);
                }, 15000)
            ),
        ]),

        // Catálogo de telas
        Promise.race([
            fetchTelasContext(idEmpresa),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando telas');
                    resolve(null);
                }, 10000)
            ),
        ]),

        // Listar TODAS las imágenes del CDN (sin filtro por nombre — Vision decidirá)
        Promise.race([
            galleryClient.listImages(idEmpresa),
            new Promise((resolve) =>
                setTimeout(() => {
                    log.warn({ idEmpresa }, 'enrichContext: timeout esperando listado de imágenes');
                    resolve([]);
                }, 8000)
            ),
        ]),
    ]);

    if (schedule) {
        sections.push(schedule);
        log.debug({ idEmpresa }, 'contextEnricher: horario inyectado');
    } else {
        log.warn({ idEmpresa }, 'contextEnricher: no se obtuvo horario');
    }
    if (telas) {
        sections.push(telas);
        log.debug({ idEmpresa }, 'contextEnricher: telas inyectadas');
    }

    // Fase 2 — catálogo de texto + galería Vision (ambos necesitan el término resuelto).
    const [products, gallery] = await Promise.all([
        resolvedProductTerm
            ? Promise.race([
                fetchProducts(idEmpresa, resolvedProductTerm),
                new Promise((resolve) =>
                    setTimeout(() => {
                        log.warn({ idEmpresa }, 'enrichContext: timeout esperando catálogo');
                        resolve(null);
                    }, 15000)
                ),
            ])
            : Promise.resolve(null),

        (resolvedProductTerm && allImageUrls.length)
            ? Promise.race([
                fetchGallery(allImageUrls, resolvedProductTerm, idEmpresa),
                new Promise((resolve) =>
                    setTimeout(() => {
                        log.warn({ idEmpresa }, 'enrichContext: timeout esperando galería Vision');
                        resolve(null);
                    }, 20000)
                ),
            ])
            : Promise.resolve(null),
    ]);

    if (products) {
        sections.push(products);
        log.debug({ idEmpresa, productLength: products.length }, 'contextEnricher: catálogo inyectado');
    }
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
    // Expuestos para tests
    _fetchSchedule: fetchSchedule,
    _fetchProducts: fetchProducts,
    _fetchGallery: fetchGallery,
    _decimalToHHMM: decimalToHHMM,
};

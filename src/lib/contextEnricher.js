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
const orderClient = require('./orderClient');
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
- chaqueta, jacket, chamarra, saco, blazer, abrigo, casaca, cazadora, sobretodo → chaqueta
- chaleco, vest → chaleco
- camisa, shirt → camisa
- polo, camiseta polo → polo
- Para cualquier otra prenda o accesorio de ropa no listada arriba: devuelve el nombre en singular y minúsculas (ej: "vestidos" → vestido, "leggins" → legging, "corbatas" → corbata)

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


// Cache del mapa de normalización de carpetas CDN por tenant.
// Clave: `${idEmpresa}:${sortedFolders}` → { map: Map<normalizedTerm, folderName>, fetchedAt }
// Se invalida automáticamente cuando el admin añade/elimina carpetas (la clave cambia).
const folderNormalizationCache = new Map();
const FOLDER_NORM_TTL_MS = 30 * 60 * 1000;

/**
 * Normaliza los nombres de carpetas CDN usando la misma función extractProductSearch
 * que normaliza los mensajes del usuario. Resultado: Map<normalizedTerm, folderName>.
 * Ej: "camiseta" → "franela", "chaquetas" → "chaqueta", "Vestidos" → "vestido"
 *
 * Al usar extractProductSearch para ambos lados (usuario y carpeta), INTENT_PROMPT
 * es la única fuente de verdad — sin tablas hardcodeadas aquí.
 */
async function buildFolderNormMap(idEmpresa, availableFolders) {
    if (!availableFolders.length) return new Map();

    const cacheKey = `${idEmpresa}:${[...availableFolders].sort().join(',')}`;
    const cached = folderNormalizationCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < FOLDER_NORM_TTL_MS) return cached.map;

    // Normalizar cada carpeta con el mismo INTENT_PROMPT del usuario (en paralelo)
    const entries = await Promise.all(
        availableFolders.map(async (folder) => {
            const normalized = await extractProductSearch(folder).catch(() => null);
            // Si extractProductSearch devuelve null (término desconocido), usar el nombre
            // de la carpeta en singular y minúsculas como fallback.
            const key = normalized || folder.toLowerCase().replace(/e?s$/, '').trim();
            return [key, folder];
        })
    );

    const map = new Map();
    for (const [key, folder] of entries) {
        if (key && !map.has(key)) map.set(key, folder);
    }

    folderNormalizationCache.set(cacheKey, { map, fetchedAt: Date.now() });
    log.info({ idEmpresa, map: [...map.entries()] }, 'buildFolderNormMap: mapa construido');
    return map;
}

/**
 * Devuelve el nombre de la carpeta CDN que corresponde al término de producto dado.
 * No contiene tablas de sinónimos — usa buildFolderNormMap para normalizar
 * dinámicamente y comparar.
 */
async function resolveGalleryFolder(idEmpresa, term, availableFolders) {
    if (!availableFolders.length) return null;

    const folderMap = await buildFolderNormMap(idEmpresa, availableFolders);
    if (!folderMap.size) return null;

    // Match directo por término normalizado
    const direct = folderMap.get(term);
    if (direct) {
        log.info({ idEmpresa, term, folder: direct }, 'resolveGalleryFolder: match directo');
        return direct;
    }

    // Match parcial: cubre casos residuales de singular/plural no manejados por INTENT_PROMPT
    const partial = [...folderMap.entries()].find(([k]) => k.startsWith(term) || term.startsWith(k));
    if (partial) {
        log.info({ idEmpresa, term, folder: partial[1] }, 'resolveGalleryFolder: match parcial');
        return partial[1];
    }

    log.info({ idEmpresa, term, folderMap: [...folderMap.entries()] }, 'resolveGalleryFolder: sin match');
    return null;
}

// ---------------------------------------------------------------------------
// Detección de intención de acción (rule-based, síncrona, sin latencia)
// ---------------------------------------------------------------------------

// Galería: el cliente quiere VER imágenes / modelos
const GALLERY_RE = /foto|imagen|fotos|imágenes|galería|galeria|muestrame|muéstrame|mostrarme|muestrenme|muéstrenme|muestre|muéstreme|muestreme|quier[oa]\s+ver|quiero\s+ver|ver\s+los?\s+modelos?|ver\s+los?\s+diseños?|(ver|mostrar|muestra).{0,30}(model|diseño|estilo|ejemplo|foto)|model.{0,30}(ver|mostrar|muestra)|otro modelo|otros modelos/i;
// Presupuesto: el cliente quiere cotizar / pedir
const PRESUPUESTO_RE = /presupuesto|cotizaci|cotizar/i;
// Compra directa: el cliente expresa intención de comprar/pedir con cantidad.
// Cuando se detecta, se suprime la galería aunque haya URLs previas, para que
// Gemini procese el pedido en vez de seguir enviando imágenes.
const COMPRA_RE = /\b(quiero\s+(comprar|pedir|ordenar|hacer\s+un\s+pedido)|quisiera\s+(comprar|pedir|ordenar)|voy\s+a\s+(comprar|pedir)|me\s+llevo|me\s+interes[ao]\s+\d|\d+\s*(unidades?|piezas?|franelas?|camisetas?|buzos?|gorras?|pantalones?|bermudas?|joggers?|polos?|chaquetas?|camisas?))\b/i;
// Órdenes/pagos/productos: el cliente pregunta por su pedido, saldo, estado o contenido de la orden.
// IMPORTANTE: los sub-patrones que terminan en palabras completas (ordenes?, pedido) pueden usar \b.
// Los que terminan en prefijos (ord) causaban falsos negativos — se reemplazaron por palabras completas.
// (?<!\w) en vez de \b: los acentuados (ó, é) son \W en JS y nunca forman \b
const ORDER_RE = /(?<!\w)(pedidos?|mis?\s+[oó]rdenes?|mi\s+[oó]rdene?|[oó]rdenes|tengo\s+\w+\s*[oó]rdenes?|la\s+orden\b|orden\s+#?\d|cu[aá]nto\s+(?:les?\s+|te\s+|le\s+)?(?:estoy\s+)?deb\w*|mi\s+deuda|saldo|abonos?|cu[aá]ndo\s+(?:me\s+)?entreg|estado\s+de\s+mi|falta\s+(?:por\s+)?pagar|cu[aá]nto\s+(?:me\s+)?falt\w*|cu[aá]nto\s+queda|pagu[eé]|pague|ya\s+pagu[eé]|pagado|mis?\s+compras?|product[oa]s?\s+de\s+(?:la\s+|esa\s+|mi\s+)?[oó]rdenes?|product[oa]s?\s+del?\s+pedido|qu[eé]\s+(?:ped[íi]|compr[eé])|detalle\s+de\s+(?:la\s+|mi\s+|esa\s+)?[oó]rdenes?|items?\s+de\s+(?:la\s+|mi\s+))/i;

/**
 * Extrae el número de teléfono de un JID de WhatsApp.
 * "5804241234567@s.whatsapp.net" → "5804241234567"
 * "@lid" JIDs no tienen número real → null
 */
function extractPhoneFromJid(jid) {
    if (!jid || jid.includes('@lid')) return null;
    const phone = jid.split('@')[0];
    return /^\d{7,15}$/.test(phone) ? phone : null;
}

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

    // Conservar el término original del usuario para la instrucción a Gemini.
    // El CDN puede tener la carpeta con un nombre diferente ("camiseta" para "franela"),
    // pero la instrucción debe referirse al término que el cliente usó para que Gemini
    // no lo confunda con otro producto que haya mostrado antes.
    const displayTerm = productTerm;

    // Paso 1: intento directo (CDN maneja singular/plural por prefix matching)
    let images = await galleryClient.listImages(idEmpresa, productTerm).catch(() => []);

    // Paso 2: si vacío, normalizar carpetas CDN y buscar por equivalencia semántica
    if (!images.length) {
        const folders = await galleryClient.listFolders(idEmpresa).catch(() => []);
        let resolvedFolder = null;
        if (folders.length) {
            resolvedFolder = await resolveGalleryFolder(idEmpresa, productTerm, folders);
        }

        if (resolvedFolder && resolvedFolder !== productTerm) {
            log.info({ idEmpresa, productTerm, resolvedFolder }, 'fetchGallery: carpeta resuelta por normalización');
            images = await galleryClient.listImages(idEmpresa, resolvedFolder).catch(() => []);
            if (images.length) productTerm = resolvedFolder; // nombre real de carpeta (para urlToGalleryTerm y continuación)
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

    // Guardar displayTerm (término del usuario, ej "franela") no productTerm
    // (carpeta CDN, ej "camiseta"), para que la lógica de continuación y el
    // texto de respaldo usen el término que el cliente reconoce.
    urlToGalleryTerm.set(next, displayTerm);

    const shown = excludeUrls.filter((u) => images.includes(u)).length;
    const remaining = images.length - shown - 1;
    log.info({ idEmpresa, productTerm, displayTerm, url: next, total: images.length, shown, remaining }, 'fetchGallery: imagen seleccionada');

    // Nota de desambiguación: si hay URLs de OTROS productos en el historial,
    // indicarle a Gemini que la imagen actual es de un producto DIFERENTE.
    const prevTerms = [...new Set(excludeUrls.map((u) => urlToGalleryTerm.get(u)).filter(Boolean))];
    const otherTerms = prevTerms.filter((t) => t !== productTerm && t !== displayTerm);
    const disambig = otherTerms.length
        ? `IMPORTANTE: Las imágenes anteriores eran de "${otherTerms.join('", "')}", NO de "${displayTerm}". Esta imagen es de "${displayTerm}" y es DIFERENTE — aún no enviada.`
        : '';

    const afterNote = remaining > 0
        ? `Después de enviar esta quedarán ${remaining} imagen(es) más de "${displayTerm}" disponibles.`
        : `Esta es la última imagen de "${displayTerm}" disponible — todavía NO enviada al cliente.`;
    return [
        `=== INSTRUCCIÓN OBLIGATORIA DE IMAGEN ===`,
        `El cliente pidió ver "${displayTerm}". La siguiente imagen AÚN NO ha sido enviada.`,
        `URL a enviar AHORA: ${next}`,
        `ACCIÓN REQUERIDA: llama a la función send_gallery_image con la URL exacta "${next}". NO inventes, NO modifiques ni uses ninguna otra URL.`,
        disambig,
        `(Conteo sesión: ${shown} de ${images.length} imagen(es) de "${displayTerm}" ya enviadas.)`,
        afterNote,
        `=== FIN INSTRUCCIÓN IMAGEN ===`,
    ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Órdenes y estado de pago del cliente
// ---------------------------------------------------------------------------

/**
 * Obtiene las órdenes activas del cliente (identificado por teléfono) y las
 * formatea como texto para que Gemini pueda responder preguntas sobre saldo,
 * abonos y fecha de entrega.
 *
 * @param {number} idEmpresa
 * @param {string} phone  - número extraído del JID (ej: "5804241234567")
 * @returns {Promise<string|null>}
 */
async function fetchOrderContext(idEmpresa, phone) {
    try {
        const result = await orderClient.fetchOrdersByPhone(idEmpresa, phone);
        if (!result || !result.found || !result.ordenes || !result.ordenes.length) {
            log.info({ idEmpresa, phone, found: result?.found }, 'fetchOrderContext: sin órdenes');
            return null;
        }

        const fmt = (n) => `$${Number(n).toFixed(2)}`;
        const fmtDate = (s) => {
            if (!s) return '-';
            const d = new Date(s);
            return isNaN(d.getTime()) ? s : d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
        };
        const fmtStatus = (s) => {
            const map = {
                pendiente: 'Pendiente', en_produccion: 'En producción',
                listo: 'Listo para entrega', entregado: 'Entregado',
                cancelada: 'Cancelada',
            };
            return map[s] || s || '-';
        };

        const lines = [
            `=== ÓRDENES DEL CLIENTE (datos en tiempo real) ===`,
            `INSTRUCCIONES CRÍTICAS:`,
            `1. Ya tienes TODAS las órdenes de ${result.customer_name || 'este cliente'} — NO pidas número de orden, NO digas que no tienes información.`,
            `2. Responde directamente usando los datos de abajo: saldo, productos, estado, fecha de entrega.`,
            `3. Esta consulta NO requiere asesor humano — NO incluyas [HANDOFF_IA].`,
        ];
        let totalDeuda = 0;
        for (const o of result.ordenes) {
            const deuda = Number(o.saldo_pendiente);
            totalDeuda += deuda;
            lines.push(
                `• Orden #${o.id_orden} | Estado: ${fmtStatus(o.status)} | ` +
                `Entrega estimada: ${fmtDate(o.fecha_entrega)} | ` +
                `Total: ${fmt(o.pago_total)} | ` +
                `Abonos: ${fmt(o.total_abonos)} | ` +
                (o.total_descuentos > 0 ? `Descuentos: ${fmt(o.total_descuentos)} | ` : '') +
                `Saldo pendiente: ${fmt(deuda)}`
            );
            if (Array.isArray(o.productos) && o.productos.length) {
                for (const p of o.productos) {
                    lines.push(`  - ${p.name} × ${p.cantidad}${p.detalle_tallas ? ` (${p.detalle_tallas})` : ''}`);
                }
            }
        }
        if (result.ordenes.length > 1) {
            lines.push(`Total adeudado (todas las órdenes): ${fmt(totalDeuda)}`);
        }

        log.info({ idEmpresa, phone, ordenes: result.ordenes.length, totalDeuda }, 'fetchOrderContext: inyectando');
        return lines.join('\n');
    } catch (err) {
        log.warn({ err: err.message, idEmpresa, phone }, 'fetchOrderContext: falló (no crítico)');
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
async function enrichContext(idEmpresa, lastUserMessage = '', { excludeGalleryUrls = [], jid = null, recentUserTexts = [] } = {}) {
    const startTime = Date.now();
    const sections = [];

    const actionIntent = detectActionIntent(lastUserMessage);
    const isCompraDirecta = COMPRA_RE.test(lastUserMessage || '');
    const isGalleryRequest = actionIntent === 'gallery' || (excludeGalleryUrls.length > 0 && !lastUserMessage);
    const isOrderRequest = ORDER_RE.test(lastUserMessage || '');
    const clientPhone = isOrderRequest ? extractPhoneFromJid(jid) : null;

    log.info({ idEmpresa, message: lastUserMessage, intent: actionIntent, isOrderRequest, isCompraDirecta, hasPhone: !!clientPhone }, 'enrichContext: INICIANDO');

    // Helper para crear un Promise.race con clearTimeout automático.
    function raceWithTimeout(promise, ms, onTimeout) {
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => { onTimeout(); resolve(null); }, ms);
        });
        return Promise.race([
            promise.finally(() => clearTimeout(timer)),
            timeout,
        ]).then((v) => { clearTimeout(timer); return v; });
    }

    // Fase 1 — todo lo independiente corre en paralelo.
    // Schedule y telas se saltan en solicitudes de galería: son irrelevantes y
    // solo añaden ruido que interfiere con la instrucción de imagen.
    const [resolvedProductTerm, schedule, telas, orderCtx] = await Promise.all([
        // Extraer término de producto del mensaje (Gemini Flash, temperatura 0)
        (lastUserMessage && lastUserMessage.length >= 2)
            ? raceWithTimeout(
                extractProductSearch(lastUserMessage),
                INTENT_TIMEOUT_MS + 500,
                () => {}
            )
            : Promise.resolve(null),

        // Horario de atención — omitir si el cliente solo pide imágenes
        isGalleryRequest
            ? Promise.resolve(null)
            : raceWithTimeout(
                fetchSchedule(idEmpresa),
                15000,
                () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando schedule')
            ),

        // Catálogo de telas — omitir si el cliente solo pide imágenes
        isGalleryRequest
            ? Promise.resolve(null)
            : raceWithTimeout(
                fetchTelasContext(idEmpresa),
                10000,
                () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando telas')
            ),

        // Órdenes del cliente — solo si el mensaje pregunta por pedidos/saldo y tenemos teléfono
        clientPhone
            ? raceWithTimeout(
                fetchOrderContext(idEmpresa, clientPhone),
                8000,
                () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando órdenes')
            )
            : Promise.resolve(null),
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
    if (orderCtx) {
        sections.push(orderCtx);
        log.debug({ idEmpresa }, 'contextEnricher: órdenes inyectadas');
    } else if (isOrderRequest && !clientPhone) {
        log.info({ idEmpresa, jid }, 'contextEnricher: pregunta de orden pero sin teléfono en JID — omitido');
    }

    // La galería solo se busca cuando el cliente explícitamente pide imágenes (intent=gallery)
    // o cuando ya se envió una imagen antes (continuación de sesión de galería).
    // EXCEPCIÓN: si el cliente expresa intención de compra directa (COMPRA_RE), suprimir
    // la galería para que Gemini procese el pedido en lugar de seguir enviando imágenes.
    const wantsGallery = !isCompraDirecta && (actionIntent === 'gallery' || excludeGalleryUrls.length > 0);

    let galleryProductTerm = wantsGallery ? resolvedProductTerm : null;
    if (!galleryProductTerm && wantsGallery && recentUserTexts && recentUserTexts.length > 0) {
        for (const text of [...recentUserTexts].reverse()) {
            if (text === lastUserMessage) continue;
            const term = await extractProductSearch(text).catch(() => null);
            if (term) {
                galleryProductTerm = term;
                log.info({ idEmpresa, galleryProductTerm, sourceText: text }, 'enrichContext: término recuperado de mensajes recientes del usuario');
                break;
            }
        }
    }

    if (!galleryProductTerm && excludeGalleryUrls.length > 0) {
        for (const url of [...excludeGalleryUrls].reverse()) {
            let term = urlToGalleryTerm.get(url);
            if (!term && url.includes('/gallery/')) {
                const parts = url.split('/');
                const idx = parts.indexOf('gallery');
                if (idx !== -1 && parts[idx + 1]) {
                    term = parts[idx + 1];
                }
            }
            if (term) {
                galleryProductTerm = term;
                log.info({ idEmpresa, galleryProductTerm, excluded: excludeGalleryUrls.length },
                    'enrichContext: término recuperado para continuación de galería');
                break;
            }
        }
    }

    // Fase 2a — catálogo (secuencial: necesitamos categoryTerm antes de buscar galería)
    const productResult = resolvedProductTerm
        ? await raceWithTimeout(
            fetchProducts(idEmpresa, resolvedProductTerm),
            15000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando catálogo')
        )
        : null;

    if (productResult?.text) {
        sections.push(productResult.text);
        log.debug({ idEmpresa }, 'contextEnricher: catálogo inyectado');
    }

    // Fase 2b — galería: fetchGallery resuelve automáticamente el nombre de carpeta CDN.
    // Paso 1: intento directo (CDN hace prefix matching). Paso 2 si vacío: lista carpetas
    // + Gemini Flash elige la más cercana semánticamente (franela → camiseta, etc.).
    const gallery = (wantsGallery && galleryProductTerm)
        ? await raceWithTimeout(
            fetchGallery(idEmpresa, galleryProductTerm, excludeGalleryUrls),
            12000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando galería')
        )
        : null;

    const elapsed = Date.now() - startTime;

    // La instrucción de galería va PRIMERO para que Gemini no la ignore por ruido de
    // otras secciones. Las demás secciones (horario, telas, catálogo) van después.
    if (gallery) {
        sections.unshift(gallery); // al inicio, máxima prioridad
        log.debug({ idEmpresa }, 'contextEnricher: galería inyectada (primero)');
    } else if (wantsGallery && galleryProductTerm && excludeGalleryUrls.length > 0) {
        sections.unshift(`NOTA INTERNA: Ya se enviaron todas las fotos disponibles de "${galleryProductTerm}" en esta conversación. Si el cliente pide más, dile que ya le mostraste todas las que tienes. NO digas que no tienes imágenes — sí las tienes, pero ya las mostraste todas.`);
        log.debug({ idEmpresa, galleryProductTerm }, 'contextEnricher: nota "galería agotada" inyectada');
    } else if (wantsGallery && galleryProductTerm) {
        sections.unshift(`NOTA INTERNA: No hay imágenes disponibles en el catálogo para "${galleryProductTerm}". Informa al cliente de forma amable que por el momento no tienes fotos disponibles de ese producto. NO llames a send_gallery_image ni inventes URLs.`);
        log.debug({ idEmpresa, galleryProductTerm }, 'contextEnricher: nota "sin imágenes" inyectada');
    }

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
    _fetchOrderContext: fetchOrderContext,
    _extractPhoneFromJid: extractPhoneFromJid,
    _decimalToHHMM: decimalToHHMM,
    _urlToGalleryTerm: urlToGalleryTerm,
};

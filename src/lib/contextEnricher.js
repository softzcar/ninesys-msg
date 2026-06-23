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
// "cuánto...deb*" y "les/te/le...deb*" toleran hasta 2-3 palabras intermedias
// (ej. "cuánto DINERO les ESTOY debiendo") — la gente no escribe estas frases
// "pegadas"; exigir adyacencia exacta causa falsos negativos recurrentes.
const ORDER_RE = /(?<!\w)(pedidos?|mis?\s+[oó]rdenes?|mi\s+[oó]rdene?|[oó]rdenes|tengo\s+\w+\s*[oó]rdenes?|la\s+orden\b|orden\s+#?\d|cu[aá]nto(?:\s+\w+){0,3}?\s+deb\w*|(?:les?|te|le)(?:\s+\w+){0,2}?\s+deb\w*|\bdeuda\b|\badeud\w*|\bdebiendo\b|saldo|abonos?|cu[aá]ndo\s+(?:me\s+)?entreg|estado\s+de\s+mi|falta\s+(?:por\s+)?pagar|cu[aá]nto\s+(?:me\s+)?falt\w*|cu[aá]nto\s+queda|pagu[eé]|pague|ya\s+pagu[eé]|pagado|mis?\s+compras?|product[oa]s?\s+de\s+(?:la\s+|esa\s+|mi\s+)?[oó]rdenes?|product[oa]s?\s+del?\s+pedido|qu[eé]\s+(?:ped[íi]|compr[eé])|detalle\s+de\s+(?:la\s+|mi\s+|esa\s+)?[oó]rdenes?|items?\s+de\s+(?:la\s+|mi\s+))/i;
// Diseño gráfico: el cliente quiere AGREGAR un servicio de diseño (logo, dibujo,
// arte gráfico) a su pedido, o pregunta qué servicios de diseño ofrecen.
// DISTINTO de GALLERY_RE: "ver diseños" = ver fotos/modelos existentes (galería);
// esto es sobre crear/redibujar un logo o arte para imprimir/estampar en la prenda.
// No incluye la palabra suelta "diseño"/"diseños" (eso es dominio de GALLERY_RE),
// solo frases específicas de servicio, para evitar falsos positivos cruzados.
const DESIGN_RE = /\b(logo|logotipo|dibujo|arte\s+gr[aá]fico|ilustraci[oó]n|estampado\s+personalizado|mockup|bordado\s+personalizado|dise[ñn]o\s+gr[aá]fico|redibuj\w*|servicios?\s+de\s+dise[ñn]o)\b/i;

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

// Continuación de galería: palabras clave que indican solicitar otra imagen,
// pero que solo son válidas si ya hay una sesión de galería activa.
const GALLERY_CONTINUATION_RE = /\b(siguiente|siguientes|otr[ao]s?|m[aá]s|ver\s+m[aá]s|p[aá]same|env[ií]ame)\b/i;

/**
 * Clasifica la intención de acción del mensaje sin llamar a Gemini.
 * @param {string} message
 * @param {boolean} hasGallerySession - si ya se enviaron imágenes en esta sesión
 * @returns {'gallery'|'presupuesto'|'catalog'}
 */
function detectActionIntent(message, hasGallerySession = false) {
    if (!message) return 'catalog';
    if (PRESUPUESTO_RE.test(message)) return 'presupuesto';
    if (GALLERY_RE.test(message)) return 'gallery';
    if (hasGallerySession && GALLERY_CONTINUATION_RE.test(message)) return 'gallery';
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

function toTitleCase(str) {
    if (!str) return '';
    return str.split(/\s+/).map(word => {
        if (!word) return '';
        if (/^(dtf|dtfuv)$/i.test(word)) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }).join(' ');
}

function formatTelasCategorized(telas) {
    const categories = {
        casual: {
            title: "Línea Casual / Algodón",
            emoji: "👕",
            match: (name) => /algod[oó]n|piqu[eé]|chemise/i.test(name),
            items: []
        },
        deportiva: {
            title: "Línea Deportiva / Dry Fit",
            emoji: "⚡",
            match: (name) => /dry\s*fit|atl[eé]tica|f[uú]tbol|deportiv/i.test(name),
            items: []
        },
        elastica: {
            title: "Línea Elástica (Licra)",
            emoji: "🧘",
            match: (name) => /licra|azuna|estefan[ií]a|eternity|sport\s*lat|sprint|el[aá]stic/i.test(name),
            items: []
        },
        accesorios: {
            title: "Accesorios y Otros",
            emoji: "🎗️",
            match: (name) => /cinta|razo|lanyard|dtf|cliente/i.test(name),
            items: []
        },
        otras: {
            title: "Otras Telas y Especialidades",
            emoji: "🧥",
            match: () => true,
            items: []
        }
    };

    for (const t of telas) {
        let matched = false;
        for (const catKey of ['casual', 'deportiva', 'elastica', 'accesorios']) {
            if (categories[catKey].match(t.nombre)) {
                categories[catKey].items.push(t);
                matched = true;
                break;
            }
        }
        if (!matched) {
            categories['otras'].items.push(t);
        }
    }

    const lines = [
        "¿Qué tipo de tela prefieres para tu pedido? 👕",
        "Estas son nuestras opciones organizadas para facilitarte la elección:\n"
    ];

    for (const catKey of ['casual', 'deportiva', 'elastica', 'otras', 'accesorios']) {
        const cat = categories[catKey];
        if (cat.items.length > 0) {
            lines.push(`${cat.emoji} *${cat.title}:*`);
            
            if (catKey === 'elastica') {
                const licras = [];
                const nonLicras = [];
                for (const item of cat.items) {
                    if (/^licra/i.test(item.nombre)) {
                        const subtype = item.nombre.replace(/^licra\s*\(?/i, '').replace(/\)?$/, '').trim();
                        if (subtype) {
                            licras.push(toTitleCase(subtype));
                        } else {
                            licras.push("Estándar");
                        }
                    } else {
                        nonLicras.push(item.nombre);
                    }
                }
                
                if (licras.length > 0) {
                    lines.push(`• Licra (${licras.join(', ')})`);
                }
                for (const nl of nonLicras) {
                    lines.push(`• ${toTitleCase(nl)}`);
                }
            } else {
                for (const item of cat.items) {
                    lines.push(`• ${toTitleCase(item.nombre)}`);
                }
            }
            lines.push(""); // empty line
        }
    }

    return lines.join("\n").trim();
}

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
        
        const formattedList = formatTelasCategorized(telas);
        
        const mappingLines = ['\n\nMapeo interno de _id (usar para submit_presupuesto, no mostrar al cliente):'];
        for (const t of telas) {
            mappingLines.push(`• ${t.nombre} -> _id: ${t._id}`);
        }
        
        return `${formattedList}${mappingLines.join('\n')}`;
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

        // Separar órdenes con saldo pendiente real de las ya pagadas/sin deuda.
        // Las preguntas de "cuánto debo/saldo" deben responderse SOLO con las
        // primeras; las segundas solo sirven para consultas de estado de un
        // pedido puntual (ver instrucciones inyectadas abajo).
        const conDeuda = result.ordenes.filter((o) => Number(o.saldo_pendiente) > 0);
        const sinDeuda = result.ordenes.filter((o) => Number(o.saldo_pendiente) <= 0);

        const lines = [
            `=== ÓRDENES DEL CLIENTE (datos en tiempo real) ===`,
            `INSTRUCCIONES CRÍTICAS:`,
            `1. Ya tienes TODAS las órdenes de ${result.customer_name || 'este cliente'} — NO pidas número de orden, NO digas que no tienes información.`,
            `2. Si el cliente pregunta cuánto debe / su saldo / su deuda: responde ÚNICAMENTE con las órdenes de la sección "CON SALDO PENDIENTE" de abajo. NUNCA menciones ni cuentes las órdenes de la sección "YA PAGADAS / SIN DEUDA" en una respuesta de saldo o deuda — esa sección es solo para responder si el cliente pregunta por el estado de un pedido específico.`,
            `3. Esta consulta NO requiere asesor humano — NO incluyas [HANDOFF_IA].`,
            `4. Presenta cada orden EXACTAMENTE como está estructurada abajo, en líneas separadas — NUNCA la condenses en una sola línea de texto corrido ni uses "|" como separador.`,
        ];

        const pushOrden = (o, conDetalle = true) => {
            lines.push('');
            lines.push(`📄 *Orden #${o.id_orden}*`);
            lines.push(`• Estado: ${fmtStatus(o.status)}`);
            lines.push(`• 📅 Entrega estimada: ${fmtDate(o.fecha_entrega)}`);
            if (conDetalle) {
                lines.push(`• Total: ${fmt(o.pago_total)}`);
                lines.push(`• Abonos: ${fmt(o.total_abonos)}`);
                if (o.total_descuentos > 0) {
                    lines.push(`• Descuentos: ${fmt(o.total_descuentos)}`);
                }
            }
            lines.push(`• 💰 Saldo pendiente: ${fmt(Number(o.saldo_pendiente))}`);
            if (Array.isArray(o.productos) && o.productos.length) {
                for (const p of o.productos) {
                    lines.push(`   - ${p.name} × ${p.cantidad}${p.detalle_tallas ? ` (${p.detalle_tallas})` : ''}`);
                }
            }
        };

        let totalDeuda = 0;
        lines.push('');
        lines.push('--- CON SALDO PENDIENTE (usar para preguntas de deuda/saldo) ---');
        if (conDeuda.length) {
            for (const o of conDeuda) {
                totalDeuda += Number(o.saldo_pendiente);
                pushOrden(o, true);
            }
            if (conDeuda.length > 1) {
                lines.push('');
                lines.push(`💰 *Total adeudado (todas las órdenes con saldo pendiente): ${fmt(totalDeuda)}*`);
            }
        } else {
            lines.push('(El cliente no tiene ninguna orden con saldo pendiente en este momento.)');
        }

        if (sinDeuda.length) {
            lines.push('');
            lines.push('--- YA PAGADAS / SIN DEUDA (NO usar para preguntas de saldo/deuda, solo para estado de un pedido puntual) ---');
            for (const o of sinDeuda) {
                pushOrden(o, false);
            }
        }

        log.info({ idEmpresa, phone, ordenes: result.ordenes.length, conDeuda: conDeuda.length, sinDeuda: sinDeuda.length, totalDeuda }, 'fetchOrderContext: inyectando');
        return lines.join('\n');
    } catch (err) {
        log.warn({ err: err.message, idEmpresa, phone }, 'fetchOrderContext: falló (no crítico)');
        return null;
    }
}

// ---------------------------------------------------------------------------
// Servicios de diseño gráfico (logo, dibujo, arte personalizado)
// ---------------------------------------------------------------------------

/**
 * Obtiene el catálogo de servicios de diseño gráfico (es_diseno=1) de la
 * empresa y lo formatea con instrucciones explícitas para que Gemini pueda
 * decidir cuál servicio agregar como ítem adicional del presupuesto.
 *
 * @param {number} idEmpresa
 * @returns {Promise<string|null>}
 */
async function fetchDesignServices(idEmpresa) {
    try {
        const payload = await catalogClient.fetchDesignCatalog(idEmpresa);
        const products = payload?.products;
        if (!Array.isArray(products) || !products.length) {
            log.info({ idEmpresa }, 'fetchDesignServices: sin productos de diseño');
            return null;
        }

        // Solo productos con precio plano real (excluye servicios sin tramo de
        // precio configurado, ej. modificadores a $0 que no son facturables).
        const usable = products.filter(
            (p) => Array.isArray(p.prices) && p.prices.length > 0 && Number(p.prices[0].price) > 0
        );
        if (!usable.length) {
            log.warn({ idEmpresa }, 'fetchDesignServices: productos de diseño sin precio usable');
            return null;
        }

        const lines = [
            `=== SERVICIOS DE DISEÑO GRÁFICO DISPONIBLES ===`,
            `INSTRUCCIONES CRÍTICAS:`,
            `1. Si el cliente, durante una cotización, menciona que quiere agregar un logotipo, dibujo u otro arte gráfico a su pedido, agrega UNO de los servicios de abajo como ÍTEM ADICIONAL en el array "items" de submit_presupuesto (además del producto principal). NO lo pongas solo en "obs": debe ir como ítem real con su propio cod/idCategory/precio.`,
            `2. Regla de inferencia — cuál servicio usar según lo que diga el cliente:`,
            `   - Logo NUEVO (no tiene uno) → "Diseño de Logo".`,
            `   - Ya tiene un logo y solo pide ajustarlo/redibujarlo/adaptarlo → "Redibujo de Logo".`,
            `   - Ambiguo, o cualquier otro arte gráfico (dibujo, ilustración, estampado personalizado, etc.) → "Diseño Gráfico" (genérico).`,
            `3. Usa EXACTAMENTE el cod, idCategory y precio de abajo — NUNCA inventes otro precio ni otro servicio.`,
            `4. La "cantidad" de este ítem SIEMPRE es 1, sin importar cuántas unidades del producto principal pida el cliente — es una tarifa única por presupuesto, NO se multiplica.`,
            `5. Informa el precio de este servicio al cliente como parte del resumen del presupuesto, igual que los demás ítems.`,
        ];

        for (const p of usable) {
            const price = Number(p.prices[0].price);
            lines.push(`• ${p.name}: [cod:${p.id}][idCat:${p.category_id || 0}] — $${price.toFixed(2)} (tarifa única)`);
        }

        log.info({ idEmpresa, count: usable.length }, 'fetchDesignServices: inyectando');
        return lines.join('\n');
    } catch (err) {
        log.warn({ err: err.message, idEmpresa }, 'fetchDesignServices: falló (no crítico)');
        return null;
    }
}

// ---------------------------------------------------------------------------
// Punto de entrada público
// ---------------------------------------------------------------------------

function getProductEmoji(name) {
    const n = name.toLowerCase();
    if (/\b(franela|chemise|polo|camiseta|t-shirt|remera)\b/i.test(n)) return '👕';
    if (/\b(gorra|cachucha|sombrero|cap)\b/i.test(n)) return '🧢';
    if (/\b(su[eé]ter|sweater|buzo|chompa|chaqueta|abrigo|hoodie)\b/i.test(n)) return '🧥';
    if (/\b(pantal[oó]n|jean|pants|jogger)\b/i.test(n)) return '👖';
    if (/\b(bermuda|short)\b/i.test(n)) return '🩳';
    return '✨';
}

function formatCatalogProducts(products) {
    const formattedProducts = [];
    for (const p of products) {
        const emoji = getProductEmoji(p.name);
        const nameCap = toTitleCase(p.name);
        
        let block = `${emoji} *${nameCap}:* [cod:${p.id}][idCat:${p.category_id || 0}]`;
        if (p.description) {
            block += ` (${p.description})`;
        }
        
        const priceLines = [];
        if (p.is_design) {
            priceLines.push(`  • (diseño personalizado — solicita cotización)`);
        } else if (p.prices && p.prices.length > 0) {
            const sortedPrices = [...p.prices].sort((a, b) => {
                const qtyA = parseInt((a.descripcion || '').match(/\d+/)?.[0] || '1', 10);
                const qtyB = parseInt((b.descripcion || '').match(/\d+/)?.[0] || '1', 10);
                return qtyA - qtyB;
            });
            
            sortedPrices.forEach((pr, i) => {
                const thisQty = parseInt((pr.descripcion || '').match(/\d+/)?.[0] || '1', 10);
                const next = sortedPrices[i + 1];
                const nextQty = next ? parseInt((next.descripcion || '').match(/\d+/)?.[0] || '99999', 10) : null;
                
                let rangeText = '';
                if (nextQty) {
                    const maxQty = nextQty - 1;
                    if (thisQty === maxQty) {
                        rangeText = `De ${thisQty} unidad`;
                    } else {
                        rangeText = `De ${thisQty} a ${maxQty} unidades`;
                    }
                } else {
                    rangeText = `${thisQty} unidades o más`;
                }
                priceLines.push(`  • ${rangeText}: *$${pr.price.toFixed(2)}* c/u`);
            });
        } else {
            priceLines.push(`  • Precio no especificado`);
        }
        
        block += '\n' + priceLines.join('\n');
        formattedProducts.push(block);
    }
    return formattedProducts.join('\n\n');
}

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

        const formattedCatalog = formatCatalogProducts(catalog.products.slice(0, 10));

        const lines = [
            '⚠️ INSTRUCCIÓN INTERNA — NO MOSTRAR AL CLIENTE: Los marcadores [cod:X][idCat:X] son referencias para la función submit_presupuesto. Jamás los incluyas en tu respuesta al cliente.',
            'Productos encontrados:',
            formattedCatalog,
        ];
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
async function enrichContext(idEmpresa, lastUserMessage = '', { excludeGalleryUrls = [], jid = null, recentUserTexts = [], registeredPhone = null, forceGallery = false } = {}) {
    const startTime = Date.now();
    const sections = [];

    let actionIntent = detectActionIntent(lastUserMessage, excludeGalleryUrls.length > 0);
    // forceGallery: el turno anterior preguntó "¿de qué producto quieres ver
    // diseños?" (red de seguridad de galería). Respuestas cortas como "de
    // franelas" no matchean GALLERY_RE (sin verbo "ver/mostrar"), cayendo en
    // 'catalog' por defecto — sin esto, Gemini queda sin bloque de galería y
    // termina inventando una URL. Solo se sobreescribe el caso por defecto;
    // si el mensaje ya matchea presupuesto/compra/orden, esa intención manda.
    if (forceGallery && actionIntent === 'catalog') {
        actionIntent = 'gallery';
    }
    const isCompraDirecta = COMPRA_RE.test(lastUserMessage || '');
    const isGalleryRequest = actionIntent === 'gallery' || (excludeGalleryUrls.length > 0 && !lastUserMessage);
    const isOrderRequest = ORDER_RE.test(lastUserMessage || '');
    // extractPhoneFromJid falla para JIDs @lid sin mapeo en wa_lid_phone_map.
    // registeredPhone es el teléfono ya conocido vía customerLookup (tabla
    // customers) cuando el cliente está registrado — sirve de respaldo para
    // que la consulta de órdenes funcione también en esos casos.
    const clientPhone = isOrderRequest ? (extractPhoneFromJid(jid) || (registeredPhone ? String(registeredPhone) : null)) : null;
    const isDesignRequest = DESIGN_RE.test(lastUserMessage || '');

    log.info({ idEmpresa, message: lastUserMessage, intent: actionIntent, isOrderRequest, isCompraDirecta, isDesignRequest, hasPhone: !!clientPhone }, 'enrichContext: INICIANDO');

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
    const [resolvedProductTerm, schedule, telas, orderCtx, designCtx] = await Promise.all([
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

        // Servicios de diseño gráfico — solo si el cliente menciona logo/dibujo/arte personalizado
        isDesignRequest
            ? raceWithTimeout(
                fetchDesignServices(idEmpresa),
                8000,
                () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando servicios de diseño')
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
    if (designCtx) {
        sections.push(designCtx);
        log.debug({ idEmpresa }, 'contextEnricher: servicios de diseño inyectados');
    }

    // No queremos forzar una nueva imagen de galería si el cliente está haciendo una
    // pregunta sobre catálogo, precios o un presupuesto, para permitir que Gemini
    // responda con texto y datos concretos en vez de interrumpir con otra imagen.
    const wantsGallery = !isCompraDirecta && (actionIntent === 'gallery');

    // Siempre intentamos deducir el término de producto del historial o del mensaje actual,
    // ya que tanto el catálogo (precios) como la galería dependen del producto activo.
    let galleryProductTerm = resolvedProductTerm;
    if (!galleryProductTerm && recentUserTexts && recentUserTexts.length > 0) {
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
    const catalogSearchTerm = resolvedProductTerm || galleryProductTerm;
    const productResult = catalogSearchTerm
        ? await raceWithTimeout(
            fetchProducts(idEmpresa, catalogSearchTerm),
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
    _fetchDesignServices: fetchDesignServices,
    _extractPhoneFromJid: extractPhoneFromJid,
    _decimalToHHMM: decimalToHHMM,
    _urlToGalleryTerm: urlToGalleryTerm,
};

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

const { GoogleGenAI, Type } = require('@google/genai');
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
 * Usa Gemini para normalizar el tipo de prenda/producto mencionado en un texto
 * suelto (SIN contexto conversacional ni banderas de intención). Se usa para
 * normalizar nombres de carpetas CDN (buildFolderNormMap) — no para mensajes
 * de cliente, que usan classifyMessage (ver abajo).
 * Retorna el término normalizado (string) o null si no hay producto.
 */
async function extractProductTerm(message) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn({ message }, 'extractProductTerm: timeout');
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
            log.warn({ err: err.message, message }, 'extractProductTerm: falló (no crítico)');
            return null;
        }
    })();

    const result = await Promise.race([call, timeout]);
    clearTimeout(timer);
    return result;
}

// ---------------------------------------------------------------------------
// Clasificador unificado de intención (LLM) — reemplaza las regex de intención
// ---------------------------------------------------------------------------

const CLASSIFY_TIMEOUT_MS = 3000;

const SAFE_FALLBACK = Object.freeze({
    productTerm: null,
    wantsGallery: false,
    wantsQuote: false,
    wantsOrderInfo: false,
    wantsDesignInfo: false,
    isCompraDirecta: false,
});

const CLASSIFY_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        productTerm: {
            type: Type.STRING,
            description: 'Término de prenda normalizado en singular y minúsculas, o la cadena "null" (como texto) si no se menciona ninguna prenda/producto.',
        },
        wantsGallery: {
            type: Type.BOOLEAN,
            description: 'true si el cliente quiere VER fotos/imágenes/modelos/diseños existentes del producto.',
        },
        wantsQuote: {
            type: Type.BOOLEAN,
            description: 'true si el cliente pide presupuesto, cotización o quiere cotizar.',
        },
        wantsOrderInfo: {
            type: Type.BOOLEAN,
            description: 'true si el cliente pregunta por sus pedidos, órdenes, saldo, deuda, abonos, estado de entrega o qué compró antes.',
        },
        wantsDesignInfo: {
            type: Type.BOOLEAN,
            description: 'true si el cliente quiere agregar/cotizar un servicio de diseño gráfico (logo, dibujo, arte, redibujo) a su pedido.',
        },
        isCompraDirecta: {
            type: Type.BOOLEAN,
            description: 'true si el cliente expresa intención de comprar/pedir ahora, con cantidad o verbo de compra explícito.',
        },
    },
    required: ['productTerm', 'wantsGallery', 'wantsQuote', 'wantsOrderInfo', 'wantsDesignInfo', 'isCompraDirecta'],
};

const CLASSIFY_PROMPT_HEADER = `Eres un asistente de una tienda de ropa personalizada en Venezuela que atiende por WhatsApp.

Analiza el ÚLTIMO mensaje del cliente (y, si se incluyen, los mensajes anteriores como contexto) y devuelve UN ÚNICO objeto JSON con estos campos:

1. "productTerm": el tipo de prenda o producto mencionado, normalizado al término estándar en español, en singular y minúsculas. Si no se menciona ninguna prenda/producto, devuelve la cadena "null" (como texto).

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

2. "wantsGallery": true si el cliente quiere VER fotos, imágenes, modelos o diseños existentes (ej: "muéstrame", "tienen fotos?", "quiero ver los modelos", "otro modelo"). También true si el mensaje es una continuación corta pidiendo más ("más", "otro", "siguiente", "pásame otra") y hay una sesión de galería activa (ver nota de contexto más abajo si aplica). NO marques true si el cliente solo pregunta precios o quiere comprar.

3. "wantsQuote": true si el cliente pide presupuesto, cotización, o quiere cotizar ("cuánto cuesta cotizar", "presupuesto para 20 franelas", "cotízame").

4. "wantsOrderInfo": true si el cliente pregunta por SUS pedidos/órdenes ya existentes, su saldo, deuda, abonos, si ya pagó, estado o fecha de entrega, o qué compró antes. Incluye frases indirectas y con palabras intercaladas, por ejemplo:
   - "cuánto debo", "cuánto les debo", "cuánto dinero les estoy debiendo en total", "oye cuánto es lo que debo"
   - "tengo alguna deuda", "estoy adeudando algo", "estoy debiendo algo o ya pagué todo"
   - "cuál es mi saldo", "mis órdenes", "el estado de mi pedido", "cuándo me entregan"
   - "ya pagué", "qué pedí", "detalle de mi orden", "productos de mi pedido"
   NO marques true para menciones genéricas de "pedido" como verbo de compra nueva (ej: "quiero hacer un pedido de 10 franelas" es una compra nueva, no una consulta — ahí usa isCompraDirecta, no wantsOrderInfo). NO marques true para "debo irme ya" (no es sobre deuda monetaria).

5. "wantsDesignInfo": true si el cliente quiere AGREGAR un servicio de diseño gráfico (logo, dibujo, arte gráfico, ilustración, estampado personalizado, mockup, bordado personalizado, redibujo) a su pedido, o pregunta qué servicios de diseño ofrecen. Esto es DISTINTO de wantsGallery: "ver diseños/modelos" (fotos de productos existentes) es wantsGallery; crear o redibujar un logo/arte propio es wantsDesignInfo.

6. "isCompraDirecta": true si el cliente expresa intención de comprar o pedir AHORA, con cantidad o verbo de compra explícito (ej: "quiero comprar 10 franelas", "me llevo 5", "voy a pedir 20 gorras", "me interesan 3 buzos").

Reglas generales:
- Puedes marcar varias banderas como true a la vez si el mensaje realmente combina intenciones (ej: "quiero 10 franelas con un logo nuevo" → productTerm: "franela", isCompraDirecta: true, wantsDesignInfo: true).
- Si el mensaje es un saludo, agradecimiento o conversación genérica sin ninguna de estas intenciones, todas las banderas deben ser false y productTerm "null".
- Responde ÚNICAMENTE con el objeto JSON, sin texto adicional.
`;

/**
 * Construye el prompt del clasificador unificado, incluyendo historial
 * reciente del cliente (para resolver términos en respuestas cortas como
 * "de franelas") y la pista de aclaración de galería pendiente si aplica.
 */
function buildClassifyPrompt(message, { recentMessages = [], pendingGalleryClarification = false } = {}) {
    const historyBlock = recentMessages.length
        ? `\nMensajes anteriores del cliente en esta conversación (contexto, del más antiguo al más reciente):\n`
          + recentMessages.slice(-3).map((m) => `- "${m}"`).join('\n') + '\n'
        : '';

    const clarificationBlock = pendingGalleryClarification
        ? `\nNOTA DE CONTEXTO: En tu turno anterior, TÚ (el bot) le preguntaste al cliente "¿De qué producto te gustaría ver diseños?". El mensaje actual del cliente es probablemente su respuesta a esa pregunta — si menciona un producto, trátalo como wantsGallery=true para ese producto aunque no incluya un verbo explícito como "ver" o "mostrar".\n`
        : '';

    return CLASSIFY_PROMPT_HEADER + historyBlock + clarificationBlock
        + `\nÚltimo mensaje del cliente: "${message}"`;
}

/**
 * Clasificador unificado de intención del mensaje del cliente (Gemini Flash).
 * Reemplaza las regex GALLERY_RE/PRESUPUESTO_RE/COMPRA_RE/ORDER_RE/DESIGN_RE +
 * detectActionIntent: en vez de patrones rígidos que rompen con frases
 * naturales ("cuánto dinero les estoy debiendo" no calzaba con la adyacencia
 * exacta que exigía ORDER_RE), una sola llamada LLM interpreta la intención
 * real. Nunca lanza excepción; ante timeout/error/sin API key devuelve
 * SAFE_FALLBACK (equivalente a "mensaje de catálogo normal, sin intención
 * especial").
 *
 * @param {string} message
 * @param {object} [context]
 * @param {string[]} [context.recentMessages]
 * @param {boolean}  [context.pendingGalleryClarification]
 * @returns {Promise<typeof SAFE_FALLBACK>}
 */
async function classifyMessage(message, context = {}) {
    if (!message || message.trim().length < 2) return { ...SAFE_FALLBACK };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ...SAFE_FALLBACK };

    let timer;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
            log.warn({ message }, 'classifyMessage: timeout');
            resolve({ ...SAFE_FALLBACK });
        }, CLASSIFY_TIMEOUT_MS);
    });

    const call = (async () => {
        try {
            const client = new GoogleGenAI({ apiKey });
            const res = await client.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [{ role: 'user', parts: [{ text: buildClassifyPrompt(message, context) }] }],
                config: {
                    temperature: 0,
                    maxOutputTokens: 256,
                    responseMimeType: 'application/json',
                    responseSchema: CLASSIFY_SCHEMA,
                    // Sin esto, el modelo puede gastar el presupuesto de
                    // maxOutputTokens en razonamiento interno antes de emitir
                    // el JSON, truncándolo (mismo problema ya resuelto para
                    // generateReply en aiService.js).
                    thinkingConfig: { thinkingBudget: 0 },
                },
            });
            const raw = JSON.parse(res?.text || '{}');
            return {
                productTerm: (!raw.productTerm || String(raw.productTerm).toLowerCase() === 'null')
                    ? null : String(raw.productTerm).toLowerCase().trim(),
                wantsGallery: !!raw.wantsGallery,
                wantsQuote: !!raw.wantsQuote,
                wantsOrderInfo: !!raw.wantsOrderInfo,
                wantsDesignInfo: !!raw.wantsDesignInfo,
                isCompraDirecta: !!raw.isCompraDirecta,
            };
        } catch (err) {
            log.warn({ err: err.message, message }, 'classifyMessage: falló (no crítico)');
            return { ...SAFE_FALLBACK };
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
 * Normaliza los nombres de carpetas CDN usando la misma función extractProductTerm
 * que normaliza los mensajes del usuario. Resultado: Map<normalizedTerm, folderName>.
 * Ej: "camiseta" → "franela", "chaquetas" → "chaqueta", "Vestidos" → "vestido"
 *
 * Al usar extractProductTerm para ambos lados (usuario y carpeta), INTENT_PROMPT
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
            const normalized = await extractProductTerm(folder).catch(() => null);
            // Si extractProductTerm devuelve null (término desconocido), usar el nombre
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
    if (!productTerm || productTerm.length < 2) return { instruction: null, totalImages: 0 };

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
        return { instruction: null, totalImages: 0 };
    }

    const next = images.find((u) => !excludeUrls.includes(u));
    if (!next) {
        log.info({ idEmpresa, productTerm, shown: excludeUrls.length }, 'fetchGallery: todas las imágenes ya fueron enviadas');
        return { instruction: null, totalImages: images.length };
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
    const instruction = [
        `=== INSTRUCCIÓN OBLIGATORIA DE IMAGEN ===`,
        `El cliente pidió ver "${displayTerm}". La siguiente imagen AÚN NO ha sido enviada.`,
        `URL a enviar AHORA: ${next}`,
        `ACCIÓN REQUERIDA: llama a la función send_gallery_image con la URL exacta "${next}". NO inventes, NO modifiques ni uses ninguna otra URL.`,
        disambig,
        `(Conteo sesión: ${shown} de ${images.length} imagen(es) de "${displayTerm}" ya enviadas.)`,
        afterNote,
        `=== FIN INSTRUCCIÓN IMAGEN ===`,
    ].filter(Boolean).join('\n');
    return { instruction, totalImages: images.length };
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
 * @param {string} [jid] - si se provee, memoriza los servicios encontrados
 *                         en shownProductsByJid para esta conversación.
 * @returns {Promise<string|null>}
 */
async function fetchDesignServices(idEmpresa, jid = null) {
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

        rememberShownProducts(jid, usable);

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

// ---------------------------------------------------------------------------
// Memoria persistente de productos cotizados — sobrevive entre turnos
// ---------------------------------------------------------------------------
//
// El marcador [cod:X][idCat:X] de un producto solo aparecía en el contexto del
// turno exacto en que ese producto se buscaba, y se le instruye a la IA NUNCA
// mostrarlo en su respuesta visible (por lo que tampoco queda en el historial
// de mensajes). En presupuestos de varios productos discutidos a lo largo de
// muchos turnos (ej. chaqueta → gorra → franela → diseño de logo), para el
// momento de la confirmación final la IA ya no tenía cod/idCategory de los
// productos más antiguos — y, siguiendo la regla de "nunca uses cod=0",
// terminaba abortando el presupuesto COMPLETO aunque los productos sí existen
// en el catálogo. Este mapa acumula cada producto mostrado por jid y se
// reinyecta SIEMPRE (no solo cuando vuelve a buscarse), hasta que el
// presupuesto se confirma con éxito (clearShownProducts, llamado desde
// waManager.js).
const shownProductsByJid = new Map(); // jid -> Map<nameLower, {name, cod, idCategory}>

function rememberShownProducts(jid, products) {
    if (!jid || !Array.isArray(products)) return;
    let memo = shownProductsByJid.get(jid);
    for (const p of products) {
        if (!p?.id || !p?.category_id) continue; // no memorizar entradas incompletas
        if (!memo) {
            memo = new Map();
            shownProductsByJid.set(jid, memo);
        }
        memo.set(String(p.name).toLowerCase(), { name: p.name, cod: p.id, idCategory: p.category_id });
    }
}

function formatShownProductsMemo(jid) {
    const memo = jid ? shownProductsByJid.get(jid) : null;
    if (!memo || !memo.size) return null;
    const lines = [
        `=== PRODUCTOS YA COTIZADOS EN ESTA CONVERSACIÓN (memoria persistente) ===`,
        `INSTRUCCIÓN CRÍTICA: Si necesitas el cod/idCategory de un producto que el cliente mencionó hace varios turnos (ej. al confirmar el presupuesto final con submit_presupuesto), búscalo AQUÍ — esta lista no se borra durante la conversación, a diferencia del catálogo de "Productos encontrados" que solo aparece en el turno en que se buscó.`,
    ];
    for (const { name, cod, idCategory } of memo.values()) {
        lines.push(`• ${name}: [cod:${cod}][idCat:${idCategory}]`);
    }
    return lines.join('\n');
}

/**
 * Limpia la memoria de productos cotizados de una conversación. Llamar tras
 * confirmar exitosamente un presupuesto (el carrito de esa cotización ya cerró).
 */
function clearShownProducts(jid) {
    if (jid) shownProductsByJid.delete(jid);
}

/**
 * Formatea el catálogo de productos para inyectar en el prompt.
 * Retorna null si no hay productos o hay error.
 *
 * @param {number} idEmpresa
 * @param {string} searchTerm
 * @param {string} [jid] - si se provee, memoriza los productos encontrados
 *                         en shownProductsByJid para esta conversación.
 * @returns {Promise<string|null>}
 */
async function fetchProducts(idEmpresa, searchTerm, jid = null) {
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

        rememberShownProducts(jid, catalog.products);

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

    // Fase 0 — clasificación de intención (LLM, reemplaza las regex de hoy) en
    // paralelo con los fetchers baratos que no dependen de ella (schedule/telas;
    // sin LLM, se descartan después si resultó ser una solicitud de galería pura,
    // en vez de esperar secuencialmente a tener la clasificación primero).
    const [classification, scheduleRaw, telasRaw] = await Promise.all([
        (lastUserMessage && lastUserMessage.length >= 2)
            ? raceWithTimeout(
                classifyMessage(lastUserMessage, {
                    recentMessages: recentUserTexts.filter((t) => t !== lastUserMessage),
                    pendingGalleryClarification: forceGallery,
                }),
                CLASSIFY_TIMEOUT_MS + 500,
                () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando classifyMessage')
            ).then((r) => r || { ...SAFE_FALLBACK })
            : Promise.resolve({ ...SAFE_FALLBACK }),

        raceWithTimeout(
            fetchSchedule(idEmpresa),
            15000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando schedule')
        ),

        raceWithTimeout(
            fetchTelasContext(idEmpresa),
            10000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando telas')
        ),
    ]);

    const isCompraDirecta = classification.isCompraDirecta;
    const isGalleryRequest = classification.wantsGallery || (excludeGalleryUrls.length > 0 && !lastUserMessage);
    const isOrderRequest = classification.wantsOrderInfo;
    // extractPhoneFromJid falla para JIDs @lid sin mapeo en wa_lid_phone_map.
    // registeredPhone es el teléfono ya conocido vía customerLookup (tabla
    // customers) cuando el cliente está registrado — sirve de respaldo para
    // que la consulta de órdenes funcione también en esos casos.
    const clientPhone = isOrderRequest ? (extractPhoneFromJid(jid) || (registeredPhone ? String(registeredPhone) : null)) : null;
    const isDesignRequest = classification.wantsDesignInfo;
    const resolvedProductTerm = classification.productTerm;

    log.info({ idEmpresa, message: lastUserMessage, classification, isOrderRequest, isCompraDirecta, isDesignRequest, hasPhone: !!clientPhone }, 'enrichContext: INICIANDO');

    // schedule/telas se pidieron siempre en paralelo con la clasificación (son
    // baratos, sin LLM); se descartan aquí si resultó ser una solicitud de
    // galería pura, donde serían ruido que interfiere con la instrucción de imagen.
    const schedule = isGalleryRequest ? null : scheduleRaw;
    const telas = isGalleryRequest ? null : telasRaw;

    // Fase 1 — fetchers que sí dependen 100% de la clasificación.
    const [orderCtx, designCtx] = await Promise.all([
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
                fetchDesignServices(idEmpresa, jid),
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
    const wantsGallery = !isCompraDirecta && classification.wantsGallery;

    // El término de producto ya viene resuelto por classifyMessage usando el
    // mensaje actual + historial reciente en una sola llamada (antes esto
    // requería hasta 4 llamadas LLM secuenciales adicionales sobre
    // recentUserTexts — eliminadas). Solo queda el fallback determinístico
    // (sin LLM) para el caso residual de continuación de galería sin texto.
    let galleryProductTerm = resolvedProductTerm;
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
            fetchProducts(idEmpresa, catalogSearchTerm, jid),
            15000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando catálogo')
        )
        : null;

    if (productResult?.text) {
        sections.push(productResult.text);
        log.debug({ idEmpresa }, 'contextEnricher: catálogo inyectado');
    }

    // Memoria persistente de productos ya cotizados — se inyecta SIEMPRE
    // (incluso si este turno no buscó ningún producto nuevo), para que la IA
    // siga teniendo el cod/idCategory de ítems mencionados muchos turnos atrás
    // al momento de armar el array "items" de submit_presupuesto.
    const shownMemo = formatShownProductsMemo(jid);
    if (shownMemo) {
        sections.push(shownMemo);
        log.debug({ idEmpresa }, 'contextEnricher: memoria de productos cotizados inyectada');
    }

    // Fase 2b — galería: fetchGallery resuelve automáticamente el nombre de carpeta CDN.
    // Paso 1: intento directo (CDN hace prefix matching). Paso 2 si vacío: lista carpetas
    // + Gemini Flash elige la más cercana semánticamente (franela → camiseta, etc.).
    const galleryResult = (wantsGallery && galleryProductTerm)
        ? await raceWithTimeout(
            fetchGallery(idEmpresa, galleryProductTerm, excludeGalleryUrls),
            12000,
            () => log.warn({ idEmpresa }, 'enrichContext: timeout esperando galería')
        )
        : null;
    const gallery = galleryResult?.instruction || null;

    const elapsed = Date.now() - startTime;

    // La instrucción de galería va PRIMERO para que Gemini no la ignore por ruido de
    // otras secciones. Las demás secciones (horario, telas, catálogo) van después.
    //
    // IMPORTANTE: la nota de "ya se mostraron todas" vs. "no hay imágenes" se decide
    // con galleryResult.totalImages (específico de ESTE producto), NO con
    // excludeGalleryUrls.length (global a toda la conversación) — antes se usaba el
    // global como proxy, lo cual le decía a Gemini "ya viste todas las fotos de X"
    // incluso cuando X nunca tuvo ninguna foto (solo se habían mostrado fotos de OTRO
    // producto antes), y Gemini terminaba inventando una URL para "cumplir".
    if (gallery) {
        sections.unshift(gallery); // al inicio, máxima prioridad
        log.debug({ idEmpresa }, 'contextEnricher: galería inyectada (primero)');
    } else if (wantsGallery && galleryProductTerm && galleryResult && galleryResult.totalImages > 0) {
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
    _classifyMessage: classifyMessage,
    _extractProductTerm: extractProductTerm,
    _formatShownProductsMemo: formatShownProductsMemo,
    clearShownProducts,
};

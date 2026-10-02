/**
 * aiReplyPlanner.js
 *
 * Interpretación PURA de la respuesta de la IA: decide qué se le enviaría al
 * cliente y qué efectos secundarios corresponden (presupuesto pendiente,
 * handoff, galería), sin ejecutar nada.
 *
 * Lo comparten:
 *   - waManager.maybeAutoReply  → ejecuta el plan (Baileys, wa_send_log, handoff)
 *   - sandboxService            → sólo lo reporta (simulador del bot)
 *
 * Así el simulador prueba exactamente la misma lógica que producción.
 * No hace I/O propio: lo que necesita del exterior (listFolders) se inyecta.
 */

// Apertura flexible: la IA a veces abrevia el tag (ej: [PRESUPUEDATA], [PRESUPUESTO_DATA]).
// Captura cualquier [PRESUP...] y su cierre correspondiente [/PRESUP...].
const PRESUPUESTO_MARKER_RE = /\[PRESUP[A-Z_]*\]([\s\S]*?)\[\/PRESUP[A-Z_]*\]/i;
const PRESUPUESTO_CONFIRM_RE = /^(s[ií]|yes|confirmo|correcto|ok|dale|listo|de acuerdo)$/i;
// Detecta si el texto visible es un resumen listo para confirmar (la IA lo envió sin marker)
const PRESUPUESTO_RESUMEN_RE = /confirmas\s+este\s+presupuesto/i;

// Markers de escalada que la IA incluye en su respuesta para solicitar handoff.
// Se extraen antes de enviar el texto al cliente (el cliente nunca los ve).
// Las versiones /g son para .replace(); la de detección va SIN /g para que
// .test() no dependa de lastIndex.
const HANDOFF_IA_MARKER_RE      = /\[HANDOFF_IA\]/gi;
const HANDOFF_CLIENTE_MARKER_RE = /\[HANDOFF_CLIENTE\]/gi;
const HANDOFF_IA_DETECT_RE      = /\[HANDOFF_IA\]/i;

// Marker de galería de imágenes: [IMG:url1|url2|...]
const IMG_MARKER_RE = /\[IMG:(https?:\/\/[^\]|]+(?:\|https?:\/\/[^\]|]+)*)\]/i;

// Textos automáticos al cliente
const TEXTS = {
    HUMAN_REQUEST: 'Por supuesto, enseguida te comunico con uno de nuestros asesores. 😊',
    NULL_REPLY: 'Disculpa, tuve un inconveniente al procesar tu mensaje. ¿Puedes repetirlo? 🙏',
    GEMINI_FAILED: 'Lo siento, tuve un problema técnico momentáneo. Por favor repite tu último mensaje. 🙏',
    CONFIRM_FALLBACK: '¿Confirmas este presupuesto? Responde *SÍ* para que lo registremos y un asesor te contacte.',
    FRUSTRATED: 'Quiero asegurarme de que recibas la mejor atención posible. He notificado a uno de nuestros asesores para que continúe contigo personalmente. 🙏',
    PHOTO_FAILED: 'Disculpa, tuve un problema técnico al enviarte esa foto. ¿Puedes decirme de nuevo qué producto quieres ver, o prefieres que te ayude con otra cosa? 🙏',
    // Respuesta a la confirmación "SÍ" del presupuesto
    PRESUPUESTO_OK: (id) => `Tu presupuesto #${id} ha sido generado. Un asesor revisará tu pedido y te contactará en breve.`,
    PRESUPUESTO_INVALID_CATALOG: 'No pude generar el presupuesto porque uno o más productos no están en nuestro catálogo. Un asesor te contactará para ayudarte directamente.',
    PRESUPUESTO_ERROR: 'Hubo un problema al generar tu presupuesto. Te atenderemos personalmente.',
    // Comandos de suscripción
    OPT_OUT: 'Has sido dado de baja de los mensajes automáticos del sistema. Seguirás recibiendo atención personalizada. Si deseas reactivarlos, escribe ALTA en cualquier momento.',
    OPT_IN: 'Mensajes automáticos reactivados. Seguirás recibiendo las actualizaciones de tus órdenes y notificaciones de forma habitual.',
    // Pie que waManager.sendText agrega a los envíos via 'api'
    API_FOOTER: '\n\n_Si deseas dejar de recibir notificaciones automáticas, responde "BAJA" o "NO"_*',
};

const OPT_OUT_COMMANDS = ['BAJA', 'NO', 'STOP', 'SALIR'];
const OPT_IN_COMMANDS = ['ALTA', 'ACTIVAR', 'START'];

const RETRY_CONFIRM_INSTRUCTION = '⚠️ INSTRUCCIÓN OBLIGATORIA: El cliente acaba de confirmar el presupuesto. Debes responder con el mensaje de confirmación Y llamar OBLIGATORIAMENTE a la función submit_presupuesto con todos los datos del pedido. Sin esa llamada el sistema no puede registrar el pedido.';

/**
 * Bloque "CLIENTE REGISTRADO" que se añade al system prompt cuando el
 * contacto existe en `customers`.
 *
 * @param {object|null} customer fila de customers (o null)
 * @returns {{ctx:string, registeredPhone:string|null, customerId:number|null, nombre:string}}
 */
function buildClienteRegistradoCtx(customer) {
    if (!customer) return { ctx: '', registeredPhone: null, customerId: null, nombre: '' };
    const nombre = [customer.first_name, customer.last_name]
        .filter(Boolean).join(' ').trim();
    const fn      = customer.first_name || '';
    const ln      = customer.last_name  || '';
    const phone   = customer.phone      || '';
    const cedula  = customer.cedula     || '';
    const address = customer.address    || '';
    const email   = customer.email      || '';
    const ctx =
        `\n=== CLIENTE REGISTRADO EN EL SISTEMA ===` +
        `\nNombre: ${nombre}` +
        `\nTeléfono: ${phone}` +
        (cedula  ? `\nCédula: ${cedula}`    : '') +
        (address ? `\nDirección: ${address}` : '') +
        (email   ? `\nEmail: ${email}`       : '') +
        `\nINSTRUCCIÓN CRÍTICA:` +
        `\n1. NO le preguntes nombre, apellido, cédula, teléfono, dirección ni ningún dato personal — ya los tienes arriba.` +
        `\n2. Pasa DIRECTAMENTE a preguntar por el pedido (producto, cantidad, talla, tela).` +
        `\n3. Al generar el JSON de presupuesto usa estos datos en "cliente": nombre="${fn}", apellido="${ln}", cedula="${cedula}", telefono="${phone}", email="${email}", direccion="${address}"` +
        `\n=== FIN DATOS CLIENTE ===\n`;
    return { ctx, registeredPhone: phone || null, customerId: customer._id ?? null, nombre };
}

/**
 * Interpreta la respuesta de la IA.
 *
 * @param {object}   p
 * @param {object|null} p.reply         resultado de aiService.generateReply
 * @param {string}   p.intentResult     'human_request' | 'frustrated' | 'none' | ...
 * @param {string}   p.cdnUrl           prefijo válido de URLs de galería
 * @param {Map}      [p.urlToGalleryTerm] url → término de galería (texto de respaldo)
 * @param {Function} [p.listFolders]    async () => string[] carpetas reales de galería
 *
 * @returns {Promise<object>} plan:
 *   kind          'human_request' | 'null_reply' | 'gemini_failed' | 'reply'
 *   rawText       texto crudo de la IA
 *   textToSend    texto final al cliente ('' = no se envía texto)
 *   imgUrls       imágenes de galería a enviar
 *   gallerySource 'function' | 'marker' | null
 *   invalidGalleryUrl URL descartada por no pertenecer al CDN
 *   presupuesto   {data, source:'function'|'marker', parseError} | null
 *   stateOps      operaciones sobre el estado de la conversación, en orden:
 *                 set_pending_presupuesto{data} | clear_confirm_sin_marker |
 *                 set_confirm_sin_marker | set_gallery_clarification
 *   handoff       {reason, trigger:'classifier'|'marker', transitionText} | null
 *   notes         [{level, msg, data}] trazas para log
 */
async function planAiReply({ reply, intentResult, cdnUrl, urlToGalleryTerm = null, listFolders = null }) {
    const plan = {
        kind: 'reply',
        rawText: reply?.text || '',
        textToSend: '',
        imgUrls: [],
        gallerySource: null,
        invalidGalleryUrl: null,
        presupuesto: null,
        stateOps: [],
        handoff: null,
        notes: [],
    };
    const note = (level, msg, data = {}) => plan.notes.push({ level, msg, data });

    // ── Escenario 3: cliente quiere hablar con un humano ──────────────────
    // El clasificador detectó human_request → la respuesta de Gemini se descarta.
    if (intentResult === 'human_request') {
        plan.kind = 'human_request';
        plan.textToSend = TEXTS.HUMAN_REQUEST;
        plan.handoff = { reason: 'cliente_solicita', trigger: 'classifier', transitionText: null };
        note('info', 'maybeAutoReply: cliente solicita asesor humano');
        return plan;
    }

    // ── Validar respuesta de la IA ────────────────────────────────────────
    if (!reply) {
        plan.kind = 'null_reply';
        plan.textToSend = TEXTS.NULL_REPLY;
        note('warn', 'maybeAutoReply: Gemini devolvió null — enviando fallback genérico');
        return plan;
    }
    if (reply.error === 'gemini_failed') {
        plan.kind = 'gemini_failed';
        plan.textToSend = TEXTS.GEMINI_FAILED;
        note('warn', 'maybeAutoReply: enviando mensaje de fallback por fallo de Gemini');
        return plan;
    }

    const functionCalls = reply.functionCalls || [];

    // Detectar marker de escalada que la IA pudo haber incluido (red de seguridad).
    const hasHandoffIa = HANDOFF_IA_DETECT_RE.test(reply.text || '');
    note('info', 'maybeAutoReply: respuesta cruda Gemini', {
        replyText: (reply.text || '').slice(0, 300),
        fcs: functionCalls.map((f) => f.name),
    });

    // Limpiar markers.
    let textToSend = (reply.text || '')
        .replace(HANDOFF_IA_MARKER_RE, '')
        .replace(HANDOFF_CLIENTE_MARKER_RE, '')
        .trim();

    // ── Galería: función nativa primero, marcador de texto como fallback ──
    const fcGallery = functionCalls.find((fc) => fc.name === 'send_gallery_image');
    if (fcGallery?.args?.url) {
        const fcUrl = String(fcGallery.args.url).trim();
        if (fcUrl.startsWith(`${cdnUrl}/`)) {
            plan.imgUrls = [fcUrl];
            plan.gallerySource = 'function';
            note('info', 'maybeAutoReply: send_gallery_image function call', { url: fcUrl });
        } else {
            plan.invalidGalleryUrl = fcUrl;
            note('warn', 'maybeAutoReply: send_gallery_image URL inválida — ignorada', { url: fcUrl });
        }
    } else {
        const imgMatch = IMG_MARKER_RE.exec(textToSend);
        if (imgMatch) {
            plan.imgUrls = imgMatch[1].split('|')
                .map((u) => u.trim())
                .filter((u) => u.startsWith(`${cdnUrl}/`))
                .slice(0, 4);
            plan.gallerySource = 'marker';
            textToSend = textToSend.replace(imgMatch[0], '').trim();
            note('info', 'maybeAutoReply: IMG marker detectado (fallback)', { urlCount: plan.imgUrls.length });
        }
    }

    // ── Presupuesto: función nativa primero, marcador de texto como fallback ──
    const fcPresupuesto = functionCalls.find((fc) => fc.name === 'submit_presupuesto');
    if (fcPresupuesto?.args) {
        plan.presupuesto = { data: fcPresupuesto.args, source: 'function', parseError: null };
        plan.stateOps.push({ op: 'set_pending_presupuesto', data: fcPresupuesto.args });
        note('info', 'maybeAutoReply: submit_presupuesto function call — presupuesto pendiente');
        if (!textToSend) {
            textToSend = TEXTS.CONFIRM_FALLBACK;
            note('warn', 'maybeAutoReply: submit_presupuesto sin texto — usando confirmación de respaldo');
        }
        plan.stateOps.push({ op: 'clear_confirm_sin_marker' });
    } else {
        const markerMatch = PRESUPUESTO_MARKER_RE.exec(textToSend);
        if (markerMatch) {
            textToSend = textToSend.replace(markerMatch[0], '').trim();
            try {
                const presupuestoData = JSON.parse(markerMatch[1]);
                plan.presupuesto = { data: presupuestoData, source: 'marker', parseError: null };
                plan.stateOps.push({ op: 'set_pending_presupuesto', data: presupuestoData });
                note('info', 'maybeAutoReply: presupuesto pendiente registrado (fallback marker)');
            } catch (parseErr) {
                plan.presupuesto = { data: null, source: 'marker', parseError: parseErr.message };
                note('warn', 'maybeAutoReply: falló parseo de PRESUPUESTO_DATA', { err: parseErr.message });
            }
            if (!textToSend) {
                textToSend = TEXTS.CONFIRM_FALLBACK;
                note('warn', 'maybeAutoReply: textToSend vacío tras extraer marker — usando confirmación de respaldo');
            }
            plan.stateOps.push({ op: 'clear_confirm_sin_marker' });
        } else if (PRESUPUESTO_RESUMEN_RE.test(textToSend)) {
            plan.stateOps.push({ op: 'set_confirm_sin_marker' });
            note('warn', 'maybeAutoReply: resumen enviado sin función ni marker — esperando "sí" para regenerar');
        }
    }

    // Garantizar texto mínimo cuando hay imagen pero Gemini no generó texto.
    if (!textToSend && plan.imgUrls.length > 0) {
        const galleryTerm = urlToGalleryTerm ? urlToGalleryTerm.get(plan.imgUrls[0]) : null;
        textToSend = galleryTerm
            ? `¡Aquí te muestro un modelo de ${galleryTerm}! ¿Te gusta el estilo? Si quieres ver otro modelo, dímelo. 😊`
            : '¡Aquí te muestro!';
        note('warn', 'maybeAutoReply: texto vacío con imagen — usando texto de respaldo contextual', { galleryTerm: galleryTerm || null });
    }

    // RED DE SEGURIDAD: Gemini llamó a send_gallery_image con URL inválida y no
    // hay texto → preguntar de qué producto quiere ver diseños, con ejemplos
    // reales del tenant (no una lista genérica: causó alucinaciones de productos).
    if (!textToSend && fcGallery?.args?.url && plan.imgUrls.length === 0) {
        const realFolders = listFolders ? await listFolders().catch(() => []) : [];
        textToSend = realFolders.length
            ? `¿De qué producto te gustaría ver diseños? Por ejemplo, puedes pedir ${realFolders.slice(0, 4).join(', ')}, etc. 😊`
            : '¿De qué producto te gustaría ver diseños?';
        plan.stateOps.push({ op: 'set_gallery_clarification' });
        note('warn', 'maybeAutoReply: URL de galería inválida y texto vacío — enviando pregunta de aclaración como fallback', { invalidUrl: fcGallery.args.url });
    }

    plan.textToSend = textToSend;

    // ── Escenario 1: IA no puede resolver / cliente frustrado ─────────────
    // Prioridad: clasificador > marker de la IA (ambos disparan el mismo handoff).
    if (intentResult === 'frustrated') {
        plan.handoff = { reason: 'ia_no_puede', trigger: 'classifier', transitionText: TEXTS.FRUSTRATED };
        note('info', 'maybeAutoReply: cliente frustrado (classifier) — escalando tras enviar respuesta');
    } else if (hasHandoffIa) {
        // La IA ya redactó el mensaje de transición antes del marker, no se duplica.
        plan.handoff = { reason: 'ia_no_puede', trigger: 'marker', transitionText: null };
        note('info', 'maybeAutoReply: IA incluyó [HANDOFF_IA] — escalando');
    }

    return plan;
}

/**
 * Decide qué hacer con un mensaje entrante de texto cuando puede haber un
 * presupuesto pendiente de confirmación. Réplica sin efectos de la rama
 * "SÍ" del handler messages.upsert de waManager.
 *
 * @returns {{action:'submit'|'cancel_pending'|'retry_with_instruction'|'none', extraCtx:string}}
 */
function planConfirmation({ pendingPres, confirmSinMarker, body }) {
    const msgNorm = (body || '').trim();
    if (pendingPres) {
        if (PRESUPUESTO_CONFIRM_RE.test(msgNorm)) {
            return { action: 'submit', extraCtx: '' };
        }
        // Cliente no confirmó — se cancela el pendiente y sigue el flujo normal
        // (no puede ser un retry: el mensaje no es una confirmación).
        return { action: 'cancel_pending', extraCtx: '' };
    }
    if (confirmSinMarker && PRESUPUESTO_CONFIRM_RE.test(msgNorm)) {
        return { action: 'retry_with_instruction', extraCtx: RETRY_CONFIRM_INSTRUCTION };
    }
    return { action: 'none', extraCtx: '' };
}

module.exports = {
    PRESUPUESTO_MARKER_RE,
    PRESUPUESTO_CONFIRM_RE,
    PRESUPUESTO_RESUMEN_RE,
    HANDOFF_IA_MARKER_RE,
    HANDOFF_CLIENTE_MARKER_RE,
    IMG_MARKER_RE,
    TEXTS,
    OPT_OUT_COMMANDS,
    OPT_IN_COMMANDS,
    RETRY_CONFIRM_INSTRUCTION,
    buildClienteRegistradoCtx,
    planAiReply,
    planConfirmation,
};

/**
 * internalMessenger.js
 *
 * Envía mensajes al sistema interno de mensajería de ninesys-api
 * (`/ws/build-message/interno`) cada vez que el bot de WhatsApp necesita
 * avisarle algo a un empleado — típicamente: "se te asignó un chat nuevo".
 *
 * El remitente lógico de estos mensajes es "el sistema" (no hay un humano
 * detrás), así que usamos un id_empleado reservado (`BOT_SENDER_ID`, default
 * 0) que no choca con empleados reales (siempre tienen id > 0).
 *
 * Best-effort: cualquier fallo de red/endpoint se loguea pero NUNCA se
 * propaga — la asignación del chat debe suceder aunque el aviso no llegue.
 */

const log = require('../lib/logger').createLogger('internalMessenger');
const lidMapping = require('./lidMapping');

const INTERNAL_MSG_URL = process.env.INTERNAL_MSG_URL
    || 'https://api.nineteengreen.com/ws/build-message/interno';
const BOT_SENDER_ID = Number(process.env.INTERNAL_MSG_BOT_SENDER_ID) || 0;
const BOT_SENDER_NAME = process.env.INTERNAL_MSG_BOT_SENDER_NAME || 'NineSys WhatsApp';

/**
 * Resuelve el id_departamento a usar para el mensaje interno dirigido a un
 * empleado concreto. El endpoint requiere un departamento válido; el
 * destinatario suele ser de Administración (7) o Comercialización (8).
 *
 * Consulta la BD central (api_empresas) — el pool del tenant tiene permisos
 * de lectura ahí porque el endpoint /empleados ya hace el mismo JOIN.
 */
async function resolveDepartmentForEmployee(pool, employeeId) {
    try {
        const [rows] = await pool.query(
            `SELECT id_departamento
             FROM api_empresas.empresas_usuarios_departamentos
             WHERE id_empleado = ? AND id_departamento IN (7, 8)
             ORDER BY FIELD(id_departamento, 8, 7)
             LIMIT 1`,
            [employeeId]
        );
        return rows[0]?.id_departamento || 8;
    } catch (e) {
        log.warn({ err: e, employeeId }, 'resolveDepartmentForEmployee falló, fallback a 8');
        return 8;
    }
}

/**
 * POST al endpoint de mensajería interna. No lanza: devuelve {ok:boolean}.
 */
async function sendInternalMessage(idEmpresa, payload) {
    const { idDestino, idDepartamento, message, idRemitente, nombreRemitente } = payload;
    if (!idDestino || !message) {
        return { ok: false, reason: 'invalid_payload' };
    }

    const body = new URLSearchParams({
        id_departamento: String(idDepartamento),
        id_destino: String(idDestino),
        id_remitente: String(idRemitente ?? BOT_SENDER_ID),
        message,
        nombre_empleado: nombreRemitente || BOT_SENDER_NAME,
    });

    try {
        const res = await fetch(INTERNAL_MSG_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': String(idEmpresa),
            },
            body: body.toString(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            log.warn(
                { tenantId: idEmpresa, status: res.status, body: text?.slice(0, 300), idDestino },
                'sendInternalMessage HTTP no-2xx'
            );
            return { ok: false, status: res.status };
        }
        log.info({ tenantId: idEmpresa, idDestino, idDepartamento }, 'Mensaje interno enviado');
        return { ok: true };
    } catch (e) {
        log.error({ err: e, tenantId: idEmpresa, idDestino }, 'sendInternalMessage falló');
        return { ok: false, error: e.message };
    }
}

function reasonToHuman(reason) {
    switch (reason) {
        case 'manual':           return 'Reasignación manual desde el panel';
        case 'reassign':         return 'Reasignación manual desde el panel';
        case 'audio_too_long':   return 'El cliente envió un audio mayor a 2 minutos';
        case 'timeout':          return 'Liberación automática por inactividad';
        case 'sticky':           return 'Cliente con historial contigo';
        case 'customer_returning': return 'Cliente recurrente que ya atendiste antes';
        case 'queue':            return 'Chat tomado desde la cola';
        default:                 return reason ? `Motivo: ${reason}` : null;
    }
}

/**
 * Notifica al vendedor que le fue asignada una conversación de WhatsApp.
 * Consulta el nombre del contacto desde la BD del tenant y arma un mensaje
 * descriptivo; delega al endpoint interno.
 *
 * Best-effort: nunca throws.
 */
async function notifyVendorOfAssignment(idEmpresa, pool, { vendorId, jid, reason }) {
    try {
        if (!vendorId || !jid) return { ok: false, reason: 'missing_params' };

        const [convRows] = await pool.query(
            `SELECT name FROM wa_conversations WHERE jid = ? LIMIT 1`,
            [jid]
        );
        const contactName = convRows[0]?.name || null;

        // Si el jid es un LID (privacy de WhatsApp), el prefijo no es un
        // teléfono real — hay que resolverlo contra wa_lid_phone_map. Baileys
        // 6.7.21 pobla ese mapeo al primer mensaje vía senderPn, así que para
        // cuando llegamos aquí ya suele estar disponible. Si aún no está,
        // omitimos el teléfono en el mensaje (mostramos solo el nombre).
        let phoneJid = jid;
        if (lidMapping.isLidJid(jid)) {
            phoneJid = (await lidMapping.resolvePhoneJid(pool, jid)) || null;
        }
        const phone = phoneJid ? (phoneJid.split('@')[0] || '').replace(/^\+?/, '') : null;
        const who = contactName
            ? (phone ? `${contactName} (+${phone})` : contactName)
            : (phone ? `+${phone}` : 'Cliente sin identificar');

        const idDepartamento = await resolveDepartmentForEmployee(pool, vendorId);
        const humanReason = reasonToHuman(reason);

        const message =
            `Se te asignó una nueva conversación de WhatsApp.\n`
            + `Cliente: ${who}\n`
            + (humanReason ? `${humanReason}.\n` : '')
            + `Abre el módulo WhatsApp > Conversaciones para atenderla.`;

        return await sendInternalMessage(idEmpresa, {
            idDestino: vendorId,
            idDepartamento,
            message,
        });
    } catch (e) {
        log.error({ err: e, tenantId: idEmpresa, vendorId, jid }, 'notifyVendorOfAssignment falló');
        return { ok: false, error: e.message };
    }
}

module.exports = {
    sendInternalMessage,
    notifyVendorOfAssignment,
};

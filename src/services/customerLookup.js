/**
 * customerLookup.js
 *
 * Dado un jid entrante, determina si el número pertenece a un cliente ya
 * registrado en la tabla `customers` y resuelve el vendedor histórico —
 * el responsable de la última orden — siempre que cumpla:
 *
 *   1. `empresas_usuarios.activo = 1`
 *   2. Pertenece al departamento 7 (Administración) o 8 (Comercialización)
 *
 * Si cualquier paso no se cumple, retorna null y el chat se procesa como
 * cliente nuevo (flujo IA normal).
 *
 * Uso: al crear una conversación de WhatsApp por primera vez.
 */

const log = require('../lib/logger').createLogger('customerLookup');
const lidMapping = require('./lidMapping');

// Cliente "Producción Interna" del template de tenants — se usa para
// órdenes administrativas internas y NO debe dispararse auto-asignación
// cuando su teléfono coincida con el jid entrante.
const CUSTOMER_SYSTEM_ID = 1;

/**
 * Extrae los últimos 10 dígitos del jid de WhatsApp.
 * Ej: '584140326592@s.whatsapp.net' → '4140326592'.
 */
function last10DigitsFromJid(jid) {
    const digits = (jid || '').replace(/\D/g, '');
    if (digits.length < 7) return null;
    return digits.slice(-10);
}

/**
 * Busca en `customers` por coincidencia de los últimos 10 dígitos del
 * teléfono. `REGEXP_REPLACE` normaliza el phone almacenado (quita espacios,
 * guiones, '+', etc.) antes de comparar — robusto para MySQL 8+.
 */
async function findCustomerByJid(pool, jid) {
    const last10 = last10DigitsFromJid(jid);
    if (!last10) return null;
    const [rows] = await pool.query(
        `SELECT _id, first_name, last_name, phone
         FROM customers
         WHERE _id <> ?
           AND phone IS NOT NULL
           AND phone <> ''
           AND REGEXP_REPLACE(phone, '[^0-9]', '') LIKE CONCAT('%', ?)
         ORDER BY moment DESC
         LIMIT 1`,
        [CUSTOMER_SYSTEM_ID, last10]
    );
    return rows[0] || null;
}

/**
 * Del historial de órdenes del cliente, selecciona al vendedor más reciente
 * que siga activo y en dpto 7/8. Un solo query con JOIN a la BD central
 * (api_empresas) filtra todo de una.
 */
async function findLastEligibleVendor(pool, customerId) {
    const [rows] = await pool.query(
        `SELECT o.responsable AS vendor_id, MAX(o.moment) AS last_order
         FROM ordenes o
         JOIN api_empresas.empresas_usuarios u
              ON u.id_usuario = o.responsable
         JOIN api_empresas.empresas_usuarios_departamentos d
              ON d.id_empleado = u.id_usuario
         WHERE o.id_wp = ?
           AND o.responsable IS NOT NULL
           AND u.activo = 1
           AND d.id_departamento IN (7, 8)
         GROUP BY o.responsable
         ORDER BY last_order DESC
         LIMIT 1`,
        [customerId]
    );
    return rows[0]?.vendor_id || null;
}

/**
 * Combina las dos búsquedas. Retorna null si no aplica.
 * En éxito: { customerId, customerName, vendorId }.
 *
 * @param {Pool}   pool
 * @param {string} jid     - jid del remitente (puede venir como @lid)
 * @param {object} [msgKey] - WAMessageKey; si trae `senderPn` (Baileys 6.7.21+)
 *                           lo usamos como fuente primaria del teléfono, sin
 *                           depender de wa_lid_phone_map.
 */
async function resolveVendorForJid(pool, jid, msgKey = null) {
    try {
        let lookupJid = jid;
        if (lidMapping.isLidJid(jid)) {
            // Preferimos senderPn de la key (Baileys 6.7.21+). Viene como
            // '<tel>@s.whatsapp.net' — lo validamos antes de confiar en él.
            const senderPn = msgKey?.senderPn || null;
            if (lidMapping.isPhoneJid(senderPn)) {
                lookupJid = senderPn;
                // Oportunístico: refrescamos el mapeo en BD para que los
                // siguientes mensajes del mismo LID resuelvan aunque no
                // venga senderPn (p.ej. mensajes de status/history).
                lidMapping.upsertMapping(pool, { lid: jid, phoneJid: senderPn }).catch(() => {});
                log.info({ lidJid: jid, phoneJid: senderPn }, '[customerLookup] LID resuelto vía senderPn');
            } else {
                // Fallback: tabla poblada por contacts.upsert/messaging-history.set.
                const phoneJid = await lidMapping.resolvePhoneJid(pool, jid);
                if (!phoneJid) {
                    log.info({ jid }, '[customerLookup] JID en @lid sin senderPn ni mapeo → cliente no identificable');
                    return null;
                }
                lookupJid = phoneJid;
                log.info({ lidJid: jid, phoneJid }, '[customerLookup] LID resuelto vía wa_lid_phone_map');
            }
        }
        const last10 = last10DigitsFromJid(lookupJid);
        const customer = await findCustomerByJid(pool, lookupJid);
        if (!customer) {
            log.info({ jid: lookupJid, last10 }, '[customerLookup] no hay customer con ese teléfono');
            return null;
        }
        const vendorId = await findLastEligibleVendor(pool, customer._id);
        if (!vendorId) {
            log.info(
                { jid, customerId: customer._id },
                '[customerLookup] customer existe pero no tiene vendedor elegible (activo + dpto 7/8)'
            );
            return null;
        }
        const name = [customer.first_name, customer.last_name]
            .filter(Boolean)
            .join(' ')
            .trim() || null;
        log.info(
            { jid, customerId: customer._id, vendorId, customerName: name },
            '[customerLookup] match OK — vendedor histórico resuelto'
        );
        return {
            customerId: customer._id,
            customerName: name,
            vendorId,
        };
    } catch (e) {
        log.warn({ err: e, jid }, '[customerLookup] resolveVendorForJid falló');
        return null;
    }
}

module.exports = {
    last10DigitsFromJid,
    findCustomerByJid,
    findLastEligibleVendor,
    resolveVendorForJid,
};

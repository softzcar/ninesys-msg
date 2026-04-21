/**
 * assignmentPolicy.js
 * 
 * Lógica de auto-asignación de conversaciones a vendedores (Fase D.2).
 */

const log = require('../lib/logger').createLogger('assignmentPolicy');

/**
 * Elige al mejor vendedor para una conversación.
 * 1. Intenta respetar al "owner_id" si está disponible.
 * 2. Si no, busca al vendedor disponible con menos chats activos.
 * 
 * @returns {Promise<number|null>} ID del usuario asignado o null si nadie disponible.
 */
async function pickNextVendor({ pool, jid, excludeUserId = null }) {
    // A. ¿Tiene dueño histórico?
    const [[conv]] = await pool.query(
        `SELECT owner_id FROM wa_conversations WHERE jid = ?`,
        [jid]
    );

    if (conv?.owner_id) {
        // B. ¿Ese dueño está disponible y no ha superado su máximo?
        const [[ownerState]] = await pool.query(
            `SELECT vs.user_id, 
                    (SELECT COUNT(*) FROM wa_conversations 
                     WHERE assigned_to = vs.user_id AND mode = 'human' AND deleted_at IS NULL) as active_count,
                    vs.max_active, vs.is_available
             FROM wa_vendor_state vs
             WHERE vs.user_id = ?`,
            [conv.owner_id]
        );

        if (ownerState && ownerState.is_available) {
            const underLimit = ownerState.max_active === 0 || ownerState.active_count < ownerState.max_active;
            if (underLimit && ownerState.user_id !== excludeUserId) {
                log.info({ jid, vendorId: ownerState.user_id }, 'Asignación Sticky: dueño histórico disponible');
                return ownerState.user_id;
            }
        }
    }

    // C. Si no hay dueño o no está disponible, buscar al "menos cargado" (Least-Loaded)
    // Se rompen empates por updated_at ASC para un round-robin suave.
    const [candidates] = await pool.query(`
        SELECT vs.user_id, 
               (SELECT COUNT(*) FROM wa_conversations 
                WHERE assigned_to = vs.user_id AND mode = 'human' AND deleted_at IS NULL) as active_count,
               vs.max_active
        FROM wa_vendor_state vs
        WHERE vs.is_available = 1
        HAVING (vs.max_active = 0 OR active_count < vs.max_active)
        ORDER BY active_count ASC, vs.updated_at ASC
        LIMIT 1
    `);

    if (candidates.length > 0) {
        log.info({ jid, vendorId: candidates[0].user_id }, 'Asignación Round-Robin: vendedor menos cargado elegido');
        return candidates[0].user_id;
    }

    log.warn({ jid }, 'Sin vendedores disponibles para asignación automática');
    return null;
}

/**
 * Obtiene el estado de disponibilidad de un vendedor.
 */
async function getVendorState(pool, userId) {
    const [[state]] = await pool.query(
        `SELECT is_available, max_active FROM wa_vendor_state WHERE user_id = ?`,
        [userId]
    );
    return state || { is_available: 1, max_active: 0 }; // Default: disponible, sin tope
}

/**
 * Actualiza el estado de disponibilidad de un vendedor (UPSERT).
 */
async function setVendorState(pool, userId, { isAvailable, maxActive }) {
    await pool.query(
        `INSERT INTO wa_vendor_state (user_id, is_available, max_active)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE 
            is_available = VALUES(is_available),
            max_active = VALUES(max_active)`,
        [userId, isAvailable ? 1 : 0, maxActive || 0]
    );
    return { user_id: userId, isAvailable, maxActive };
}

/**
 * Lista todos los estados de vendedores de un tenant.
 */
async function listVendorStates(pool) {
    const [rows] = await pool.query(`
        SELECT vs.user_id, vs.is_available, vs.max_active,
               (SELECT COUNT(*) FROM wa_conversations 
                WHERE assigned_to = vs.user_id AND mode = 'human' AND deleted_at IS NULL) as active_count
        FROM wa_vendor_state vs
    `);
    return rows;
}

module.exports = {
    pickNextVendor,
    getVendorState,
    setVendorState,
    listVendorStates
};

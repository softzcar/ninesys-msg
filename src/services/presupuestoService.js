/**
 * presupuestoService.js
 *
 * Orquesta la creación automática de un presupuesto desde una conversación
 * de WhatsApp, usando los datos recolectados por la IA.
 *
 * Flujo:
 *   1. Resolver IDs de talla y tela para cada item
 *   2. Lookup/creación del cliente en `customers`
 *   3. INSERT en `presupuestos` y `presupuestos_productos`
 *   4. Asignar vendedor (histórico o aleatorio)
 *   5. Disparar handoff a humano (asigna conversación + notifica vendedor)
 */

const sizesClient = require('../lib/sizesClient');
const telasClient = require('../lib/telasClient');
const customerLookup = require('./customerLookup');
const assignmentPolicy = require('./assignmentPolicy');
const log = require('../lib/logger').createLogger('presupuestoService');

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDatetime(d = new Date()) {
    return d.toISOString().replace('T', ' ').substring(0, 19);
}

function today() {
    return new Date().toISOString().substring(0, 10);
}

/**
 * Resuelve los IDs de talla y tela para cada item del pedido.
 * Los items que no tengan talla/tela resolubles se marcan con id null
 * (el insert igual procede, con el campo en null).
 */
async function resolveItemIds(idEmpresa, items) {
    return Promise.all(
        items.map(async (item) => {
            // La IA envía item.tela como el _id numérico de catalogo_telas (viene del
            // contexto inyectado). Si por alguna razón llega un nombre de texto, se hace
            // fallback a resolveTela para mantener compatibilidad.
            const telaRaw = item.tela;
            const telaAsId = telaRaw !== null && telaRaw !== undefined && telaRaw !== ''
                && !Number.isNaN(Number(telaRaw));

            const [sizeId, telaId] = await Promise.all([
                item.talla ? sizesClient.resolveSize(idEmpresa, item.talla) : Promise.resolve(null),
                telaAsId
                    ? Promise.resolve(Number(telaRaw))
                    : (telaRaw ? telasClient.resolveTela(idEmpresa, telaRaw) : Promise.resolve(null)),
            ]);

            if (!sizeId) {
                log.warn({ idEmpresa, talla: item.talla }, 'presupuestoService: talla no resuelta a ID');
            }
            if (!telaId) {
                log.warn({ idEmpresa, tela: item.tela }, 'presupuestoService: tela no resuelta a ID');
            }

            return { ...item, sizeId, telaId };
        })
    );
}

/**
 * Busca el cliente por JID. Si no existe lo crea.
 * Devuelve { customerId, vendorId|null }.
 * vendorId viene del historial del cliente (último vendedor activo).
 */
async function resolveCustomer(pool, jid, clienteData, clientPhone = '') {
    // Buscar cliente existente por JID
    let existing = await customerLookup.findCustomerByJid(pool, jid);

    // Fallback: los JIDs @lid no contienen el teléfono real; usar clientPhone
    // que ya viene resuelto desde waManager antes de llamar a submit().
    if (!existing && clientPhone) {
        existing = await customerLookup.findCustomerByJid(pool, clientPhone);
        if (existing) {
            log.info({ jid, customerId: existing._id }, 'presupuestoService: cliente encontrado por teléfono (fallback @lid)');
        }
    }

    if (existing) {
        const vendorId = await customerLookup.findLastEligibleVendor(pool, existing._id);
        log.info({ jid, customerId: existing._id, vendorId }, 'presupuestoService: cliente existente encontrado');
        return { customerId: existing._id, vendorId };
    }

    // Cliente nuevo: insertar en customers
    const nombre    = (clienteData.nombre    || '').trim();
    const apellido  = (clienteData.apellido  || '').trim();
    const cedula    = (clienteData.cedula    || '').trim() || null;  // null evita UNIQUE '' duplicado
    const telefono  = clientPhone || (clienteData.telefono || '').trim();
    const email     = (clienteData.email     || '').trim().toLowerCase();
    const direccion = (clienteData.direccion || '').trim() || null;

    const emailFinal = email || `${(nombre[0] || 'x').toLowerCase()}${Math.random().toString(36).substring(2, 10)}@email.com`;

    const [result] = await pool.query(
        `INSERT INTO customers (first_name, last_name, cedula, phone, email, address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [nombre, apellido, cedula, telefono, emailFinal, direccion]
    );

    const customerId = result.insertId;
    log.info({ jid, customerId }, 'presupuestoService: nuevo cliente creado');
    return { customerId, vendorId: null };
}

/**
 * Inserta el presupuesto y sus líneas de producto.
 * Devuelve el id del presupuesto creado.
 */
async function createPresupuesto(pool, { cliente, customerId, items, obs, total }) {
    const now = formatDatetime();
    const todayStr = today();
    const clienteNombre = [cliente.nombre, cliente.apellido].filter(Boolean).join(' ').trim();
    const fechaEntregaFinal = todayStr;

    const [presResult] = await pool.query(
        `INSERT INTO presupuestos
           (id_wp_order, responsable, moment, pago_descuento, pago_abono, id_wp,
            cliente_cedula, observaciones, pago_total, cliente_nombre,
            fecha_inicio, fecha_entrega, fecha_creacion, status)
         VALUES (0, NULL, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'En espera')`,
        [
            now,
            customerId || null,
            cliente.cedula || '',
            obs || '',
            total,
            clienteNombre,
            todayStr,
            fechaEntregaFinal,
            todayStr,
        ]
    );

    const presupuestoId = presResult.insertId;
    log.info({ presupuestoId, clienteNombre, total }, 'presupuestoService: presupuesto creado');

    // Insertar líneas de producto
    for (const item of items) {
        await pool.query(
            `INSERT INTO presupuestos_productos
               (moment, precio_unitario, precio_woo, name, id_orden, id_woo,
                cantidad, id_category, category_name, talla, corte, tela,
                id_products_attributes, id_size, id_tela)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
            [
                now,
                item.precio ?? 0,
                String(item.precio ?? 0),
                item.productoNombre,
                presupuestoId,
                item.cod || null,
                item.cantidad,
                item.idCategory ?? 0,
                item.categoryName || 'Sin categoría',
                item.sizeId ? String(item.sizeId) : String(item.talla || '').substring(0, 32),
                item.corte || '',
                item.telaId ? String(item.telaId) : (item.tela || ''),
                item.sizeId || null,
                item.telaId || null,
            ]
        );
    }

    log.info({ presupuestoId, lineCount: items.length }, 'presupuestoService: productos insertados');
    return presupuestoId;
}

// ─── Punto de entrada público ────────────────────────────────────────────────

/**
 * Crea el presupuesto completo desde los datos del AI y dispara el handoff.
 *
 * @param {object}   opts
 * @param {number}   opts.idEmpresa
 * @param {object}   opts.pool         - tenant DB pool (mysql2 promise)
 * @param {string}   opts.jid          - JID del cliente en WhatsApp
 * @param {object}   opts.data         - datos del [PRESUPUESTO_DATA] parseado
 * @param {Function} opts.handoffFn    - waManager.handoffToHuman(idEmpresa, pool, jid, reason, opts)
 * @returns {Promise<{ok: boolean, id_presupuesto: number|null, vendorId: number|null}>}
 */
async function submit({ idEmpresa, pool, jid, data, clientPhone = '', handoffFn }) {
    let _step = 'init';
    try {
        log.info({ idEmpresa, jid, itemCount: data.items?.length }, 'presupuestoService: iniciando submit');

        // 1. Resolver IDs
        _step = 'resolveItemIds';
        const resolvedItems = await resolveItemIds(idEmpresa, data.items || []);

        // 2. Cliente
        _step = 'resolveCustomer';
        const { customerId, vendorId: historicVendorId } = await resolveCustomer(pool, jid, data.cliente || {}, clientPhone);

        // 3. Calcular total
        const total = resolvedItems.reduce(
            (sum, item) => sum + (Number(item.precio) || 0) * (Number(item.cantidad) || 0),
            0
        );

        // 4. Crear presupuesto
        _step = 'createPresupuesto';
        const presupuestoId = await createPresupuesto(pool, {
            cliente: data.cliente || {},
            customerId,
            items: resolvedItems,
            obs: data.obs,
            total,
        });

        // 5. Elegir vendedor
        _step = 'pickNextVendor';
        let vendorId = historicVendorId;
        if (!vendorId) {
            vendorId = await assignmentPolicy.pickNextVendor({ pool, jid });
            log.info({ jid, vendorId }, 'presupuestoService: vendedor asignado por política');
        }

        // 6. Asignar vendedor al presupuesto
        _step = 'assignVendor';
        if (vendorId) {
            await pool.query(
                'UPDATE presupuestos SET responsable = ? WHERE _id = ?',
                [vendorId, presupuestoId]
            );
        }

        // 7. Handoff: asigna conversación al vendedor + notifica
        _step = 'handoff';
        await handoffFn(idEmpresa, pool, jid, 'presupuesto_generado', {
            forcedVendorId: vendorId,
        });

        log.info({ idEmpresa, jid, presupuestoId, vendorId }, 'presupuestoService: submit completado');
        return { ok: true, id_presupuesto: presupuestoId, vendorId };
    } catch (err) {
        log.error({ err: err.message, stack: err.stack, step: _step, idEmpresa, jid }, 'presupuestoService: submit falló');
        return { ok: false, id_presupuesto: null, vendorId: null };
    }
}

module.exports = { submit };

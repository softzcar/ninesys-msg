/**
 * assignmentTimeout.js
 *
 * Loop periódico que libera conversaciones asignadas cuyo vendedor no ha
 * respondido en X minutos HÁBILES (Fase D.3).
 *
 * Algoritmo por tick:
 *   1. Para cada tenant con pool activo en tenantResolver:
 *      a. Resolver horario laboral vía businessHoursClient (con cache).
 *         Si la API cayó y no hay cache → skip el tenant (failsafe: mejor
 *         no liberar nada que liberar todo por error).
 *      b. Listar conversaciones con assigned_to != NULL y mode='human'.
 *      c. Para cada una, calcular minutos hábiles transcurridos desde
 *         last_vendor_reply_at (o assigned_at si aún no respondió).
 *      d. Si supera el umbral: liberar (assigned_to=NULL, assigned_at=NULL,
 *         last_vendor_reply_at=NULL) y reasignar vía handoffToHuman
 *         excluyendo al vendedor actual (para que no vuelva a caerle).
 *      e. Emitir 'conversation:released' al panel para refresco de UI.
 *   2. Errores por tenant NO detienen el loop; se loguean y se continúa.
 *
 * Variables de entorno:
 *   ASSIGNMENT_TIMEOUT_MINUTES       → umbral en minutos hábiles (default 20)
 *   ASSIGNMENT_TIMEOUT_INTERVAL_MS   → frecuencia del loop (default 60000)
 *   ASSIGNMENT_TIMEOUT_DISABLED      → '1' para no arrancar (debug)
 */

const tenantResolver = require('../db/tenantResolver');
const businessHoursClient = require('../lib/businessHoursClient');
const businessHours = require('../lib/businessHours');
const conversationStore = require('./conversationStore');
const waManager = require('./waManager');
const log = require('../lib/logger').createLogger('assignmentTimeout');

const DEFAULT_THRESHOLD_MIN = 20;
const DEFAULT_INTERVAL_MS = 60_000;

let _intervalHandle = null;
let _running = false;        // reentrancy guard (un tick a la vez)
let _stopRequested = false;

function thresholdMinutes() {
    const raw = Number(process.env.ASSIGNMENT_TIMEOUT_MINUTES);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_MIN;
}

function intervalMs() {
    const raw = Number(process.env.ASSIGNMENT_TIMEOUT_INTERVAL_MS);
    return Number.isFinite(raw) && raw >= 5_000 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Procesa un tenant: libera y reasigna las conversaciones que hayan
 * superado el umbral. Devuelve stats para el log agregado del tick.
 */
async function processTenant(tenantId, pool, nowMs, threshold) {
    const hours = await businessHoursClient.fetchBusinessHours(tenantId);
    if (!hours) {
        log.debug({ tenantId }, 'Sin horario laboral resoluble — skip tenant');
        return { scanned: 0, released: 0, skipped: true };
    }

    const rows = await conversationStore.listAssignedForTimeout(pool);
    if (!rows.length) {
        return { scanned: 0, released: 0 };
    }

    let released = 0;
    for (const row of rows) {
        try {
            const clockAt = row.last_vendor_reply_at || row.assigned_at;
            if (!clockAt) continue;
            const sinceMs = new Date(clockAt).getTime();
            if (!Number.isFinite(sinceMs)) continue;

            const elapsed = businessHours.minutesElapsedBusiness(sinceMs, nowMs, hours);
            if (elapsed < threshold) continue;

            const previousVendor = row.assigned_to;
            const wasReleased = await conversationStore.releaseAssignment(pool, row.jid);
            if (!wasReleased) continue;
            released++;

            log.info(
                { tenantId, jid: row.jid, previousVendor, elapsedMin: Math.round(elapsed) },
                'Conversación liberada por timeout'
            );

            // Reasignar (excluyendo al anterior). Si no hay nadie más, se
            // queda en cola.
            const handoffRes = await waManager.handoffToHuman(
                tenantId, pool, row.jid, 'timeout',
                { excludeUserId: previousVendor }
            );

            // Evento al panel
            waManager.emit(tenantId, 'conversation:released', {
                companyId: tenantId,
                jid: row.jid,
                previousVendor,
                reassignedTo: handoffRes?.assignedTo || null,
                reason: 'timeout',
                elapsedMin: Math.round(elapsed),
            });
        } catch (e) {
            log.error({ err: e, tenantId, jid: row.jid }, 'Error liberando conversación');
        }
    }

    return { scanned: rows.length, released };
}

/**
 * Un tick del loop. Idempotente y best-effort por tenant.
 */
async function runTick() {
    if (_running || _stopRequested) return;
    _running = true;
    const nowMs = Date.now();
    const threshold = thresholdMinutes();
    const tenants = [...tenantResolver._state.tenants.entries()]
        .filter(([, entry]) => entry && entry.pool);

    if (!tenants.length) {
        _running = false;
        return;
    }

    let totalScanned = 0;
    let totalReleased = 0;
    let tenantsProcessed = 0;

    for (const [tenantId, entry] of tenants) {
        if (_stopRequested) break;
        try {
            const stats = await processTenant(tenantId, entry.pool, nowMs, threshold);
            totalScanned += stats.scanned;
            totalReleased += stats.released;
            tenantsProcessed++;
        } catch (e) {
            log.error({ err: e, tenantId }, 'processTenant falló');
        }
    }

    if (totalScanned > 0 || totalReleased > 0) {
        log.info(
            { tenants: tenantsProcessed, scanned: totalScanned, released: totalReleased, thresholdMin: threshold },
            'Tick de timeout completado'
        );
    }
    _running = false;
}

/**
 * Arranca el loop. Idempotente: si ya está corriendo, no hace nada.
 */
function start() {
    if (process.env.ASSIGNMENT_TIMEOUT_DISABLED === '1') {
        log.warn('ASSIGNMENT_TIMEOUT_DISABLED=1 — loop no arrancado');
        return;
    }
    if (_intervalHandle) return;
    _stopRequested = false;
    const interval = intervalMs();
    log.info(
        { intervalMs: interval, thresholdMin: thresholdMinutes() },
        'Loop de timeout arrancado'
    );
    _intervalHandle = setInterval(() => {
        runTick().catch((e) => log.error({ err: e }, 'runTick falló (no capturado)'));
    }, interval);
    // No mantener el event loop vivo sólo por este timer (permite exit limpio).
    if (typeof _intervalHandle.unref === 'function') _intervalHandle.unref();
}

/**
 * Para el loop. Espera a que el tick actual termine si hay uno en vuelo.
 */
async function stop() {
    _stopRequested = true;
    if (_intervalHandle) {
        clearInterval(_intervalHandle);
        _intervalHandle = null;
    }
    // Breve espera si hay un tick en vuelo.
    const started = Date.now();
    while (_running && Date.now() - started < 3000) {
        await new Promise((r) => setTimeout(r, 50));
    }
    log.info('Loop de timeout detenido');
}

module.exports = {
    start,
    stop,
    // Expuestos sólo para tests
    _internal: { runTick, processTenant },
};

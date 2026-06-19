/**
 * retentionService.js
 *
 * Servicio de retención y limpieza periódica para mensajes de WhatsApp
 * y archivos multimedia locales.
 *
 * Ejecuta:
 *   1. Limpieza de base de datos: elimina mensajes de wa_messages que superen
 *      la cantidad de días configurada en MESSAGE_RETENTION_DAYS (default 30).
 *   2. Limpieza de archivos en disco: elimina archivos multimedia en MEDIA_ROOT
 *      que tengan fecha de modificación superior a MEDIA_RETENTION_DAYS (default 60).
 */

const tenantResolver = require('../db/tenantResolver');
const conversationStore = require('./conversationStore');
const mediaStore = require('./mediaStore');
const log = require('../lib/logger').createLogger('retentionService');

const DEFAULT_RETENTION_DAYS = 30;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function runCleanup() {
    log.info('Iniciando limpieza periódica de mensajes viejos y archivos multimedia...');
    
    // 1. Limpieza de archivos multimedia en disco
    try {
        const mediaRetentionDays = Number(process.env.MEDIA_RETENTION_DAYS) || mediaStore.RETENTION_DAYS || 60;
        log.info({ days: mediaRetentionDays }, 'Ejecutando limpieza de archivos en disco...');
        const stats = mediaStore.cleanupOlderThan(mediaRetentionDays);
        log.info(stats, 'Limpieza de archivos en disco completada');
    } catch (e) {
        log.error({ err: e }, 'Error al limpiar archivos multimedia en disco');
    }

    // 2. Limpieza de base de datos por cada tenant activo
    const messageRetentionDays = Number(process.env.MESSAGE_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    const tenants = [...tenantResolver._state.tenants.entries()]
        .filter(([, entry]) => entry && entry.pool);
        
    log.info({ tenants: tenants.length, days: messageRetentionDays }, 'Ejecutando purga de mensajes viejos en base de datos...');
    for (const [tenantId, entry] of tenants) {
        try {
            const deletedCount = await conversationStore.purgeOldMessages(entry.pool, messageRetentionDays);
            if (deletedCount > 0) {
                log.info({ tenantId, deletedCount }, 'Mensajes antiguos eliminados de la base de datos');
            }
        } catch (e) {
            log.error({ err: e, tenantId }, 'Error al purgar mensajes antiguos en base de datos');
        }
    }
    log.info('Limpieza periódica completada con éxito');
}

let _intervalHandle = null;

function start() {
    if (process.env.RETENTION_CLEANUP_DISABLED === '1') {
        log.warn('Limpieza de retención desactivada (RETENTION_CLEANUP_DISABLED=1)');
        return;
    }
    
    log.info('Iniciando servicio de retención y limpieza periódica');
    
    // Ejecutar limpieza inicial a los 30 segundos de arrancar
    setTimeout(() => {
        runCleanup().catch(e => log.error({ err: e }, 'Limpieza inicial falló'));
    }, 30000);
    
    // Programar limpieza cada 24 horas
    _intervalHandle = setInterval(() => {
        runCleanup().catch(e => log.error({ err: e }, 'Limpieza periódica programada falló'));
    }, ONE_DAY_MS);
    
    if (typeof _intervalHandle.unref === 'function') _intervalHandle.unref();
}

function stop() {
    if (_intervalHandle) {
        clearInterval(_intervalHandle);
        _intervalHandle = null;
    }
    log.info('Servicio de retención y limpieza periódica detenido');
}

module.exports = {
    start,
    stop,
    // Expuesto para ejecución manual en test
    runCleanup
};

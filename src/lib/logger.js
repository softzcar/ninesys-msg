/**
 * logger.js
 *
 * Logger estructurado de la aplicación basado en Pino (Fase 9.1).
 *
 * Reemplaza console.log/error/warn por un logger JSON con niveles, campos
 * contextuales (tenantId, jid, reqId, module) y serialización automática
 * de errores. La idea es que cuando llegue el frontend de Fase futura
 * pueda consumir estos logs estructurados (vía pm2 logs, archivo rotado,
 * o un agregador) y filtrar por cualquier campo.
 *
 * Uso típico:
 *   const log = require('../lib/logger').createLogger('waManager');
 *   log.info({ tenantId: 163 }, 'sesión READY');
 *   log.error({ err, jid }, 'envío falló');
 *
 * Y para tener contexto pegado a un tenant/jid concreto:
 *   const childLog = log.child({ tenantId: 163, jid: '...' });
 *   childLog.info('mensaje persistido');   // ya lleva tenantId+jid
 *
 * Niveles (de menor a mayor severidad):
 *   trace (10) | debug (20) | info (30) | warn (40) | error (50) | fatal (60)
 *
 * Variables de entorno:
 *   LOG_LEVEL  → nivel mínimo a emitir (default: info en prod, debug en dev)
 *   NODE_ENV   → si !== 'production', usa pino-pretty para output legible
 */

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

// En desarrollo: pretty-print coloreado a stdout.
// En producción: JSON puro a stdout (PM2 lo captura via pm2-logrotate).
const transport = isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
        },
    };

const baseLogger = pino({
    level,
    base: { service: 'msg_ninesys' }, // campo fijo en cada log para distinguir del resto del stack
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
        err: pino.stdSerializers.err,
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
    },
    transport,
});

/**
 * Crea un child logger con un campo `module` fijo. Convención: cada archivo
 * que loguee importa esto una sola vez al tope con su propio nombre.
 */
function createLogger(moduleName) {
    return baseLogger.child({ module: moduleName });
}

module.exports = {
    logger: baseLogger,
    createLogger,
};

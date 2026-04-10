/**
 * requestLogger.js
 *
 * Middleware Express que asigna un Request ID a cada petición HTTP y crea
 * un child logger con ese ID. A partir de este middleware, los handlers
 * deben usar `req.log` en lugar del logger global para que sus mensajes
 * queden correlacionados con la request entera.
 *
 * Comportamiento:
 *   - Lee header `X-Request-ID` si viene del cliente (útil cuando el frontend
 *     manda su propio ID para correlacionar con sus logs).
 *   - Si no viene, genera uno corto (8 chars hex).
 *   - Lo expone como `req.id` y lo devuelve en `X-Request-ID` de la respuesta.
 *   - Crea `req.log` = child logger con { reqId, method, path }.
 *   - Loguea automáticamente cada request entrante (info) y cada respuesta
 *     terminada con su status + duración (info para 2xx/3xx, warn para 4xx,
 *     error para 5xx).
 */

const crypto = require('crypto');
const { logger } = require('../lib/logger');

const HEADER = 'x-request-id';

function shortId() {
    return crypto.randomBytes(4).toString('hex'); // 8 chars
}

function requestLogger(req, res, next) {
    const incoming = req.headers[HEADER];
    req.id = (incoming && String(incoming).slice(0, 64)) || shortId();
    res.setHeader('X-Request-ID', req.id);

    req.log = logger.child({
        reqId: req.id,
        method: req.method,
        path: req.path,
    });

    const start = process.hrtime.bigint();
    req.log.info('request:start');

    res.on('finish', () => {
        const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
        const fields = { status: res.statusCode, durMs };
        if (res.statusCode >= 500) {
            req.log.error(fields, 'request:end');
        } else if (res.statusCode >= 400) {
            req.log.warn(fields, 'request:end');
        } else {
            req.log.info(fields, 'request:end');
        }
    });

    next();
}

module.exports = requestLogger;

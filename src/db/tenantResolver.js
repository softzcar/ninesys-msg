/**
 * tenantResolver.js
 *
 * Multi-tenant DB resolver para msg_ninesys.
 *
 * Mantiene:
 *   - Un cache de credenciales por id_empresa con TTL.
 *   - Un pool mysql2 dedicado por tenant, creado lazy.
 *
 * Uso típico:
 *   const pool = await tenantResolver.getPool(163);
 *   const [rows] = await pool.query('SELECT 1');
 *
 * Reglas:
 *   - Las credenciales se resuelven contra ninesys-api vía credentialsClient.
 *   - Los pools se reutilizan entre llamadas.
 *   - Si las credenciales cambian (refresh), el pool viejo se cierra.
 */

const mysql = require('mysql2/promise');
const credentialsClient = require('./credentialsClient');
const log = require('../lib/logger').createLogger('tenantResolver');

const CREDENTIALS_TTL_MS = 10 * 60 * 1000; // 10 minutos
const POOL_DEFAULTS = {
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
};

// { [idEmpresa]: { credentials, fetchedAt, pool } }
const tenants = new Map();

/**
 * Resuelve credenciales (con cache TTL).
 */
async function getCredentials(idEmpresa, { forceRefresh = false } = {}) {
    const id = parseInt(idEmpresa, 10);
    const entry = tenants.get(id);
    const now = Date.now();

    if (
        !forceRefresh &&
        entry &&
        entry.credentials &&
        now - entry.fetchedAt < CREDENTIALS_TTL_MS
    ) {
        return entry.credentials;
    }

    const credentials = await credentialsClient.fetchCredentials(id);
    const next = entry || {};
    next.credentials = credentials;
    next.fetchedAt = now;
    tenants.set(id, next);
    return credentials;
}

/**
 * Devuelve un pool mysql2 para la empresa, creándolo lazy.
 */
async function getPool(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const credentials = await getCredentials(id);
    const entry = tenants.get(id);

    if (entry.pool) return entry.pool;

    const pool = mysql.createPool({
        host: credentials.db_host,
        user: credentials.db_user,
        password: credentials.db_password,
        database: credentials.db_name,
        ...POOL_DEFAULTS,
    });

    entry.pool = pool;
    tenants.set(id, entry);
    log.info(
        { tenantId: id, dbUser: credentials.db_user, dbHost: credentials.db_host, dbName: credentials.db_name },
        'Pool creado'
    );
    return pool;
}

/**
 * Invalida cache + cierra pool de una empresa (o de todas).
 * Útil tras cambios de credenciales o en shutdown.
 */
async function refresh(idEmpresa) {
    if (idEmpresa === undefined) {
        const all = [...tenants.keys()];
        await Promise.all(all.map(refresh));
        return;
    }
    const id = parseInt(idEmpresa, 10);
    const entry = tenants.get(id);
    if (!entry) return;
    if (entry.pool) {
        try {
            await entry.pool.end();
        } catch (e) {
            log.warn({ err: e, tenantId: id }, 'Error cerrando pool');
        }
    }
    tenants.delete(id);
    log.info({ tenantId: id }, 'Cache y pool invalidados');
}

/**
 * Test de conexión: ping a ninesys-api + SELECT 1 en api_emp_{id}.
 */
async function testConnection(idEmpresa) {
    await credentialsClient.ping();
    const pool = await getPool(idEmpresa);
    const [rows] = await pool.query('SELECT 1 AS ok');
    return rows[0].ok === 1;
}

/**
 * Cierra todos los pools MySQL (graceful shutdown, Fase 9.3).
 */
async function shutdown() {
    const entries = [...tenants.entries()];
    log.info({ count: entries.length }, 'tenantResolver: shutdown iniciado');
    await Promise.all(entries.map(async ([id, entry]) => {
        if (entry.pool) {
            try { await entry.pool.end(); }
            catch (e) { log.warn({ err: e, tenantId: id }, 'error cerrando pool'); }
        }
    }));
    tenants.clear();
    log.info('tenantResolver: shutdown completado');
}

module.exports = {
    getCredentials,
    getPool,
    refresh,
    testConnection,
    shutdown,
    _state: { tenants },
};

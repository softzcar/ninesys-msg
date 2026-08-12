/**
 * tenantResolver.js
 *
 * Multi-tenant DB resolver para msg_ninesys.
 * Soporta drivers MySQL (mysql2) y PostgreSQL (pg) de manera transparente.
 *
 * Mantiene:
 *   - Un cache de credenciales por id_empresa con TTL.
 *   - Un pool dedicado por tenant (wrapper unificado), creado lazy.
 *
 * Uso típico:
 *   const pool = await tenantResolver.getPool(163);
 *   const [rows] = await pool.query('SELECT 1');
 */

const mysql = require('mysql2/promise');
const { Pool: PgPool } = require('pg');
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

/**
 * Wrapper unificado para normalizar la API de pool.query([sql, params])
 * entre PostgreSQL (pg) y MySQL (mysql2).
 */
class TenantPoolWrapper {
    constructor(rawPool, driver) {
        this.rawPool = rawPool;
        this.driver = driver; // 'pgsql' | 'mysql'
    }

    async query(sql, params = []) {
        if (this.driver === 'pgsql') {
            // Convertir marcadores de posición ? a $1, $2, $3... para PostgreSQL
            let idx = 1;
            const pgSql = sql.replace(/\?/g, () => `$${idx++}`);
            const res = await this.rawPool.query(pgSql, params);
            const rows = res.rows || [];
            rows.affectedRows = res.rowCount;
            rows.insertId = res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : null;
            return [rows, res];
        } else {
            return await this.rawPool.query(sql, params);
        }
    }

    async execute(sql, params = []) {
        return this.query(sql, params);
    }

    async end() {
        return await this.rawPool.end();
    }
}

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
 * Devuelve un pool (TenantPoolWrapper) para la empresa, creándolo lazy.
 */
async function getPool(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    const credentials = await getCredentials(id);
    const entry = tenants.get(id);

    if (entry && entry.pool) return entry.pool;

    const driver = (credentials.db_driver || '').toLowerCase();
    const isPg = driver === 'pgsql' || credentials.db_port === 5432;
    let wrapper;

    if (isPg) {
        const pgPool = new PgPool({
            host: credentials.db_host,
            user: credentials.db_user,
            password: credentials.db_password,
            database: credentials.db_name,
            port: credentials.db_port || 5432,
            max: 5,
        });
        wrapper = new TenantPoolWrapper(pgPool, 'pgsql');
    } else {
        const mysqlPool = mysql.createPool({
            host: credentials.db_host,
            user: credentials.db_user,
            password: credentials.db_password,
            database: credentials.db_name,
            port: credentials.db_port || 3306,
            ...POOL_DEFAULTS,
        });
        wrapper = new TenantPoolWrapper(mysqlPool, 'mysql');
    }

    const next = entry || {};
    next.pool = wrapper;
    tenants.set(id, next);

    log.info(
        { tenantId: id, dbUser: credentials.db_user, dbHost: credentials.db_host, dbName: credentials.db_name, driver: isPg ? 'pgsql' : 'mysql' },
        'Pool de base de datos creado'
    );
    return wrapper;
}

/**
 * Invalida cache + cierra pool de una empresa (o de todas).
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
 * Test de conexión: ping a ninesys-api + SELECT 1 en la base del tenant.
 */
async function testConnection(idEmpresa) {
    await credentialsClient.ping();
    const pool = await getPool(idEmpresa);
    const [rows] = await pool.query('SELECT 1 AS ok');
    return rows[0] && (rows[0].ok === 1 || rows[0].ok === '1');
}

/**
 * Cierra todos los pools de DB (graceful shutdown).
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
    TenantPoolWrapper,
    _state: { tenants },
};

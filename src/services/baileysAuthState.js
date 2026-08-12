/**
 * baileysAuthState.js
 *
 * Adapter de useAuthState para @whiskeysockets/baileys con backend MySQL/PostgreSQL.
 * Persiste credenciales y keys en la tabla `wa_session_auth` del tenant
 * (api_emp_{id_empresa}). Reemplaza el directorio .wwebjs_auth/ del esquema
 * anterior y permite que cualquier instancia del proceso reanude la sesión
 * sin compartir filesystem.
 */

const log = require('../lib/logger').createLogger('baileysAuthState');

let _baileys;
async function lib() {
    if (!_baileys) {
        _baileys = await import('baileys');
    }
    return _baileys;
}

async function readKey(pool, key) {
    const [rows] = await pool.query(
        'SELECT key_value FROM wa_session_auth WHERE key_name = ? LIMIT 1',
        [key]
    );
    if (!rows || !rows.length || !rows[0].key_value) return null;
    try {
        const { BufferJSON } = await lib();
        const raw = rows[0].key_value;
        const str = Buffer.isBuffer(raw) ? raw.toString('utf8') : (typeof raw === 'string' ? raw : String(raw));
        return JSON.parse(str, BufferJSON.reviver);
    } catch (e) {
        log.warn({ err: e, key }, 'No pude parsear key');
        return null;
    }
}

async function writeKey(pool, key, value) {
    const { BufferJSON } = await lib();
    const data = JSON.stringify(value, BufferJSON.replacer);

    if (pool.driver === 'pgsql') {
        await pool.query(
            `INSERT INTO wa_session_auth (key_name, key_value, updated_at)
             VALUES (?, ?, NOW())
             ON CONFLICT (key_name) DO UPDATE SET key_value = EXCLUDED.key_value, updated_at = NOW()`,
            [key, Buffer.from(data, 'utf8')]
        );
    } else {
        await pool.query(
            `INSERT INTO wa_session_auth (key_name, key_value)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)`,
            [key, Buffer.from(data, 'utf8')]
        );
    }
}

async function removeKey(pool, key) {
    await pool.query('DELETE FROM wa_session_auth WHERE key_name = ?', [key]);
}

/**
 * Crea un AuthState compatible con Baileys, respaldado por MySQL/PostgreSQL.
 * @param {TenantPoolWrapper} pool - pool del tenant
 */
async function useMySQLAuthState(pool) {
    // Asegurar tabla wa_session_auth si no existe
    if (pool.driver === 'pgsql') {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wa_session_auth (
                key_name VARCHAR(255) PRIMARY KEY,
                key_value BYTEA,
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `).catch(err => log.warn({ err }, 'Error comprobando tabla wa_session_auth (pgsql)'));
    }

    const { initAuthCreds, proto } = await lib();
    let creds = await readKey(pool, 'creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeKey(pool, 'creds', creds);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readKey(pool, `${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            if (value) data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(
                                value ? writeKey(pool, key, value) : removeKey(pool, key)
                            );
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            await writeKey(pool, 'creds', creds);
        },
        /**
         * Borra TODAS las credenciales y keys del tenant. Equivalente a un
         * logout completo (regenera QR en el siguiente init).
         */
        clear: async () => {
            await pool.query('DELETE FROM wa_session_auth');
        },
    };
}

module.exports = { useMySQLAuthState };

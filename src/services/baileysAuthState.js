/**
 * baileysAuthState.js
 *
 * Adapter de useAuthState para @whiskeysockets/baileys con backend MySQL.
 * Persiste credenciales y keys en la tabla `wa_session_auth` del tenant
 * (api_emp_{id_empresa}). Reemplaza el directorio .wwebjs_auth/ del esquema
 * anterior y permite que cualquier instancia del proceso reanude la sesión
 * sin compartir filesystem.
 *
 * Uso:
 *   const { state, saveCreds, clear } = await useMySQLAuthState(pool);
 *   const sock = makeWASocket({ auth: state, ... });
 *   sock.ev.on('creds.update', saveCreds);
 *
 * Esquema de la tabla (ver db/migrations/001_wa_tables.sql):
 *   wa_session_auth(key_name VARCHAR(255) PK, key_value LONGBLOB, updated_at)
 *
 * Convenciones de key_name:
 *   - 'creds'                     → credenciales principales
 *   - '<type>-<id>'               → keys (pre-key, session, sender-key, ...)
 */

// Carga diferida: baileys es ESM y solo debe importarse cuando el flag
// USE_BAILEYS=1 está activo, para no romper el modo legacy (sin la dep).
const log = require('../lib/logger').createLogger('baileysAuthState');

let _baileys;
function lib() {
    if (!_baileys) _baileys = require('baileys');
    return _baileys;
}

async function readKey(pool, key) {
    const [rows] = await pool.query(
        'SELECT key_value FROM wa_session_auth WHERE key_name = ? LIMIT 1',
        [key]
    );
    if (!rows.length) return null;
    try {
        return JSON.parse(rows[0].key_value.toString('utf8'), lib().BufferJSON.reviver);
    } catch (e) {
        log.warn({ err: e, key }, 'No pude parsear key');
        return null;
    }
}

async function writeKey(pool, key, value) {
    const data = JSON.stringify(value, lib().BufferJSON.replacer);
    await pool.query(
        `INSERT INTO wa_session_auth (key_name, key_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE key_value = VALUES(key_value)`,
        [key, Buffer.from(data, 'utf8')]
    );
}

async function removeKey(pool, key) {
    await pool.query('DELETE FROM wa_session_auth WHERE key_name = ?', [key]);
}

/**
 * Crea un AuthState compatible con Baileys, respaldado por MySQL.
 * @param {import('mysql2/promise').Pool} pool - pool del tenant
 */
async function useMySQLAuthState(pool) {
    const { initAuthCreds, proto } = lib();
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

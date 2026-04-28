/**
 * telasClient.js
 *
 * Obtiene el catálogo de telas de ninesys-api y lo expone como un Map
 * para resolución rápida durante la construcción del payload de presupuesto.
 *
 * Endpoint: GET {API_URL}/telas
 * Header:   Authorization: {id_empresa}
 * Cache TTL: 24 horas (telas casi nunca cambian)
 *
 * Matching: para tolerar variaciones ("atlética" vs "ATLÉTICA 1.60") se
 * indexan dos claves por cada tela: el nombre completo normalizado y la
 * primera palabra en lowercase. La primera palabra permite encontrar
 * "atlética" aunque el nombre almacenado sea "atlética 1.60".
 * Cuando haya colisión (dos telas con la misma primera palabra), se
 * conserva solo el nombre completo y la resolución por primera palabra
 * queda deshabilitada para esa clave.
 */

const axios = require('axios');
const log = require('./logger').createLogger('telasClient');

const API_URL = process.env.API_URL;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const http = axios.create({
    baseURL: API_URL,
    timeout: 5000,
    headers: { Accept: 'application/json' },
});

// Map<idEmpresa, { map: Map<key, id>, fetchedAt }>
const cache = new Map();

/**
 * Devuelve un Map de nombre_tela_normalizado → id.
 * Se indexa tanto el nombre completo como la primera palabra (si es única).
 * Ej: "atlética" → 5, "atlética 1.60" → 5, "dry fit" → 47
 *
 * @param {number} idEmpresa
 * @returns {Promise<Map<string, number>>}
 */
async function fetchTelas(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) {
        log.warn({ idEmpresa }, 'telasClient: id_empresa inválido');
        return new Map();
    }

    const cached = cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.map;
    }

    try {
        const res = await http.get('/telas', {
            headers: { Authorization: String(id) },
        });

        const data = res.data?.data;
        if (!Array.isArray(data)) {
            log.warn({ id }, 'telasClient: respuesta inesperada');
            return new Map();
        }

        const map = new Map();
        // Conteo de primera palabra para detectar colisiones
        const firstWordCount = new Map();

        for (const item of data) {
            if (!item.tela || !item._id) continue;
            const fullKey = String(item.tela).toLowerCase().trim();
            map.set(fullKey, Number(item._id));

            const firstWord = fullKey.split(/\s+/)[0];
            firstWordCount.set(firstWord, (firstWordCount.get(firstWord) ?? 0) + 1);
        }

        // Agregar alias por primera palabra solo si es única (sin colisión)
        for (const item of data) {
            if (!item.tela || !item._id) continue;
            const fullKey = String(item.tela).toLowerCase().trim();
            const firstWord = fullKey.split(/\s+/)[0];
            if ((firstWordCount.get(firstWord) ?? 0) === 1 && !map.has(firstWord)) {
                map.set(firstWord, Number(item._id));
            }
        }

        cache.set(id, { map, fetchedAt: Date.now() });
        log.info({ id, count: map.size }, 'telasClient: telas cargadas');
        return map;
    } catch (err) {
        log.error({ id, err: err.message }, 'telasClient: falló la carga');
        return cached?.map ?? new Map();
    }
}

/**
 * Resuelve un nombre de tela a su ID numérico.
 * Primero intenta el nombre completo normalizado, luego la primera palabra.
 * Retorna null si no se encuentra.
 *
 * @param {number} idEmpresa
 * @param {string} telaName  - ej: "Atlética", "Dry Fit", "algodón"
 * @returns {Promise<number|null>}
 */
async function resolveTela(idEmpresa, telaName) {
    const map = await fetchTelas(idEmpresa);
    const key = String(telaName).toLowerCase().trim();

    if (map.has(key)) return map.get(key);

    // Fallback: primera palabra
    const firstWord = key.split(/\s+/)[0];
    return map.get(firstWord) ?? null;
}

module.exports = { fetchTelas, resolveTela };

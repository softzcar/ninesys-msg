/**
 * sizesClient.js
 *
 * Obtiene el catálogo de tallas de ninesys-api y lo expone como un Map
 * name.toLowerCase() → id, para resolución rápida durante la construcción
 * del payload de presupuesto.
 *
 * Endpoint: GET {API_URL}/sizes
 * Header:   Authorization: {id_empresa}
 * Cache TTL: 24 horas (tallas casi nunca cambian)
 */

const axios = require('axios');
const log = require('./logger').createLogger('sizesClient');

const API_URL = process.env.API_URL;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const http = axios.create({
    baseURL: API_URL,
    timeout: 5000,
    headers: { Accept: 'application/json' },
});

// Map<idEmpresa, { map: Map<name, id>, fetchedAt }>
const cache = new Map();

/**
 * Devuelve un Map de nombre_talla_lowercase → id para una empresa.
 * Ej: "s" → 71, "m" → 73, "xl" → 75
 *
 * @param {number} idEmpresa
 * @returns {Promise<Map<string, number>>}
 */
async function fetchSizes(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) {
        log.warn({ idEmpresa }, 'sizesClient: id_empresa inválido');
        return new Map();
    }

    const cached = cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.map;
    }

    try {
        const res = await http.get('/sizes', {
            headers: { Authorization: String(id) },
        });

        const data = res.data?.data;
        if (!Array.isArray(data)) {
            log.warn({ id }, 'sizesClient: respuesta inesperada');
            return new Map();
        }

        const map = new Map();
        for (const item of data) {
            if (item.name && item._id) {
                map.set(String(item.name).toLowerCase().trim(), Number(item._id));
            }
        }

        cache.set(id, { map, fetchedAt: Date.now() });
        log.info({ id, count: map.size }, 'sizesClient: tallas cargadas');
        return map;
    } catch (err) {
        log.error({ id, err: err.message }, 'sizesClient: falló la carga');
        return cached?.map ?? new Map();
    }
}

/**
 * Resuelve un nombre de talla a su ID numérico.
 * Retorna null si no se encuentra.
 *
 * @param {number} idEmpresa
 * @param {string} sizeName  - ej: "S", "M", "XL"
 * @returns {Promise<number|null>}
 */
async function resolveSize(idEmpresa, sizeName) {
    const map = await fetchSizes(idEmpresa);
    return map.get(String(sizeName).toLowerCase().trim()) ?? null;
}

module.exports = { fetchSizes, resolveSize };

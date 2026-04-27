/**
 * catalogClient.js
 *
 * Cliente HTTP para el endpoint interno de ninesys-api que devuelve el
 * catálogo de productos de una empresa (para enriquecimiento de contexto IA).
 *
 * Endpoint: GET {API_URL}/internal/catalog/{id_empresa}?search=término
 * Header:   Authorization: {id_empresa}
 *
 * Cache en memoria con TTL: el catálogo cambia ocasionalmente, y evitamos
 * golpear ninesys-api en cada generación de respuesta. TTL: 30 minutos.
 */

const axios = require('axios');
const log = require('./logger').createLogger('catalogClient');

const API_URL = process.env.API_URL;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

if (!API_URL) {
    log.warn('API_URL no está definida en .env');
}

const http = axios.create({
    baseURL: API_URL,
    timeout: 5000,
    headers: { Accept: 'application/json' },
});

// { [idEmpresa]: { [searchTerm]: { value, fetchedAt } } }
const cache = new Map();

/**
 * Obtiene productos del catálogo de una empresa. No lanza excepciones.
 *
 * @param {number} idEmpresa
 * @param {string} searchTerm    - término de búsqueda (ej: "remera")
 * @returns {Promise<object|null>} respuesta del endpoint o null si falla
 */
async function fetchCatalog(idEmpresa, searchTerm) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) {
        log.warn({ idEmpresa }, 'id_empresa inválido — no se consulta');
        return null;
    }

    const searchNorm = String(searchTerm || '').toLowerCase().trim();
    const cacheKey = `${searchNorm}`;

    // Cache hit fresco
    const companyCache = cache.get(id);
    if (companyCache) {
        const entry = companyCache.get(cacheKey);
        const now = Date.now();
        if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
            return entry.value;
        }
    }

    // Miss o stale → pedir a la API
    try {
        const res = await http.get(`/internal/catalog/${id}`, {
            params: { search: searchTerm },
            headers: { Authorization: String(id) },
        });

        const payload = res.data;
        if (!payload || typeof payload !== 'object') {
            log.warn({ tenantId: id, searchTerm }, 'Respuesta 200 pero payload inválido');
            return null;
        }

        // Cachear
        const now = Date.now();
        if (!cache.has(id)) cache.set(id, new Map());
        cache.get(id).set(cacheKey, { value: payload, fetchedAt: now });

        return payload;
    } catch (err) {
        const status = err.response?.status;
        const reason = err.response?.data?.error || err.code || err.message;
        log.error(
            {
                tenantId: id,
                searchTerm,
                status,
                reason,
                message: err.message,
                code: err.code,
                url: `${API_URL}/internal/catalog/${id}?search=${searchTerm}`
            },
            'fetchCatalog falló'
        );
        return null;
    }
}

/**
 * Invalida el cache del catálogo para una empresa (o todo si se omite).
 * Útil cuando se actualiza el catálogo.
 */
function invalidate(idEmpresa) {
    if (idEmpresa === undefined) {
        cache.clear();
        return;
    }
    const id = parseInt(idEmpresa, 10);
    cache.delete(id);
}

module.exports = {
    fetchCatalog,
    invalidate,
    _state: { cache },
};

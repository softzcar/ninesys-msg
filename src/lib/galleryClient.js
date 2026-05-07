const axios = require('axios');
const log = require('./logger').createLogger('galleryClient');

const CDN_URL = process.env.CDN_URL || 'https://cdn.nineteengreen.com';
const CACHE_TTL_MS = 5 * 60 * 1000;

const http = axios.create({ baseURL: CDN_URL, timeout: 8000, headers: { Accept: 'application/json' } });

// Cache: `${idEmpresa}:${productTerm}` → { value: string[], fetchedAt }
const cache = new Map();

/**
 * Devuelve las imágenes de la carpeta gallery/{idEmpresa}/{productTerm}/ en el CDN.
 * El administrador sube las fotos pre-clasificadas a esa carpeta.
 *
 * @param {number} idEmpresa
 * @param {string} productTerm  - término normalizado (ej: "camiseta", "gorra")
 * @returns {Promise<string[]>}  Array de URLs públicas
 */
async function listImages(idEmpresa, productTerm) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) return [];

    const term = String(productTerm || '').toLowerCase().trim();
    if (!term) return [];

    const key = `${id}:${term}`;
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

    try {
        const res = await http.get('/', { params: { action: 'catalog', id_empresa: id, product: term } });
        const images = Array.isArray(res.data?.images) ? res.data.images : [];
        cache.set(key, { value: images, fetchedAt: Date.now() });
        log.info({ id, term, count: images.length }, 'galleryClient: imágenes listadas');
        return images;
    } catch (err) {
        log.warn({ id, term, err: err.message }, 'galleryClient: falló (no crítico)');
        return cached?.value ?? [];
    }
}

module.exports = { listImages, _state: { cache } };

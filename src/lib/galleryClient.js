const axios = require('axios');
const log = require('./logger').createLogger('galleryClient');

const CDN_URL = process.env.CDN_URL || 'https://cdn.nineteengreen.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 8;

const http = axios.create({ baseURL: CDN_URL, timeout: 5000, headers: { Accept: 'application/json' } });

// Map<idEmpresa, Map<term, { value: string[], fetchedAt }>>
const cache = new Map();

async function listImages(idEmpresa, searchTerm) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) return [];

    const term = String(searchTerm || '').toLowerCase().trim();
    const companyCache = cache.get(id);
    if (companyCache) {
        const entry = companyCache.get(term);
        if (entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS) return entry.value;
    }

    try {
        const res = await http.get('/', { params: { action: 'list', id_empresa: id, search: term } });
        const images = Array.isArray(res.data?.images) ? res.data.images.slice(0, MAX_RESULTS) : [];
        if (!cache.has(id)) cache.set(id, new Map());
        cache.get(id).set(term, { value: images, fetchedAt: Date.now() });
        log.info({ id, term, count: images.length }, 'galleryClient: imágenes obtenidas');
        return images;
    } catch (err) {
        log.warn({ id, term, err: err.message }, 'galleryClient: falló (no crítico)');
        return [];
    }
}

module.exports = { listImages, _state: { cache } };

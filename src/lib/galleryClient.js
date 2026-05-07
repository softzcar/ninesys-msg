const axios = require('axios');
const log = require('./logger').createLogger('galleryClient');

const CDN_URL = process.env.CDN_URL || 'https://cdn.nineteengreen.com';
const CACHE_TTL_MS = 5 * 60 * 1000;

const http = axios.create({ baseURL: CDN_URL, timeout: 8000, headers: { Accept: 'application/json' } });

// Cache por empresa: id_empresa → { value: string[], fetchedAt }
// No se cachea por término porque siempre traemos todas las imágenes (el filtro lo hace Vision).
const cache = new Map();

/**
 * Devuelve TODAS las imágenes del directorio images/{idEmpresa}/ en el CDN.
 * El filtrado de relevancia lo hace Gemini Vision en contextEnricher.
 *
 * @param {number} idEmpresa
 * @returns {Promise<string[]>}  Array de URLs públicas
 */
async function listImages(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) return [];

    const cached = cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

    try {
        const res = await http.get('/', { params: { action: 'list', id_empresa: id } });
        const images = Array.isArray(res.data?.images) ? res.data.images : [];
        cache.set(id, { value: images, fetchedAt: Date.now() });
        log.info({ id, count: images.length }, 'galleryClient: imágenes listadas');
        return images;
    } catch (err) {
        log.warn({ id, err: err.message }, 'galleryClient: falló (no crítico)');
        return cached?.value ?? [];
    }
}

module.exports = { listImages, _state: { cache } };

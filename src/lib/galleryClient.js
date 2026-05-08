const axios = require('axios');
const log = require('./logger').createLogger('galleryClient');

const CDN_URL = process.env.CDN_URL || 'https://cdn.nineteengreen.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const FOLDERS_CACHE_TTL_MS = 10 * 60 * 1000;

const http = axios.create({ baseURL: CDN_URL, timeout: 8000, headers: { Accept: 'application/json' } });

// Cache de imágenes: `${idEmpresa}:${productTerm}` → { value: string[], fetchedAt }
const cache = new Map();
// Cache de carpetas disponibles: idEmpresa → { value: string[], fetchedAt }
const foldersCache = new Map();

/**
 * Devuelve las imágenes de la carpeta gallery/{idEmpresa}/{productTerm}/ en el CDN.
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

/**
 * Devuelve la lista de carpetas de galería disponibles para un tenant.
 * Resultado: string[] con los nombres de carpeta (ej: ["camiseta", "chaquetas", "gorras"]).
 * Se cachea 10 minutos.
 */
async function listFolders(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) return [];

    const cached = foldersCache.get(id);
    if (cached && Date.now() - cached.fetchedAt < FOLDERS_CACHE_TTL_MS) return cached.value;

    try {
        const res = await http.get('/', { params: { action: 'gallery_categories', id_empresa: id } });
        const cats = Array.isArray(res.data?.categories) ? res.data.categories : [];
        const folders = cats.filter((c) => c.count > 0).map((c) => c.name);
        foldersCache.set(id, { value: folders, fetchedAt: Date.now() });
        log.info({ id, folders }, 'galleryClient: carpetas listadas');
        return folders;
    } catch (err) {
        log.warn({ id, err: err.message }, 'galleryClient: listFolders falló');
        return foldersCache.get(id)?.value ?? [];
    }
}

module.exports = { listImages, listFolders, _state: { cache, foldersCache } };

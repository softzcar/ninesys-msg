/**
 * orderClient.js
 *
 * Cliente HTTP para el endpoint interno de ninesys-api que devuelve las
 * órdenes activas de un cliente identificado por número de teléfono.
 *
 * Endpoint: GET {API_URL}/internal/ordenes/{id_empresa}/by-phone?phone={phone}
 * Header:   Authorization: {id_empresa}
 *
 * Cache de 3 minutos: los saldos cambian con frecuencia pero consultar por
 * cada mensaje sería excesivo — 3 min equilibra frescura y carga.
 *
 * Retorno de fetchOrdersByPhone():
 *   Éxito (200):  { found: true, customer_id, customer_name, ordenes: [...] }
 *   No encontrado: { found: false }
 *   Error/red:    null
 */

const axios = require('axios');
const log = require('./logger').createLogger('orderClient');

const API_URL = process.env.API_URL;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutos

if (!API_URL) {
    log.warn('API_URL no está definida en .env — orderClient no funcionará');
}

const http = axios.create({
    baseURL: API_URL,
    timeout: 5000,
    headers: { Accept: 'application/json' },
});

// clave: `${id_empresa}:${phone}` → { value, fetchedAt }
const cache = new Map();

/**
 * Obtiene las órdenes activas de un cliente por teléfono. No lanza excepciones.
 *
 * @param {number} idEmpresa
 * @param {string} phone  - número en formato JID sin '@': ej "5804241234567"
 * @returns {Promise<object|null>}
 */
async function fetchOrdersByPhone(idEmpresa, phone) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0 || !phone) return null;

    const key = `${id}:${phone}`;
    const now = Date.now();
    const entry = cache.get(key);
    if (entry && now - entry.fetchedAt < CACHE_TTL_MS) return entry.value;

    try {
        const res = await http.get(`/internal/ordenes/${id}/by-phone`, {
            params: { phone },
            headers: { Authorization: String(id) },
        });
        const value = res.data;
        cache.set(key, { value, fetchedAt: now });
        log.debug({ idEmpresa: id, phone, found: value?.found, count: value?.ordenes?.length }, 'fetchOrdersByPhone: ok');
        return value;
    } catch (err) {
        const status = err.response?.status;
        const reason = err.response?.data?.error || err.code || err.message;
        log.warn({ idEmpresa: id, phone, status, reason }, 'fetchOrdersByPhone: falló');
        if (entry) return { ...entry.value, _stale: true };
        return null;
    }
}

/**
 * Invalida el cache de un tenant/teléfono o de todo si se omiten los argumentos.
 */
function invalidate(idEmpresa, phone) {
    if (idEmpresa === undefined) { cache.clear(); return; }
    if (phone === undefined) {
        const prefix = `${parseInt(idEmpresa, 10)}:`;
        for (const k of cache.keys()) { if (k.startsWith(prefix)) cache.delete(k); }
        return;
    }
    cache.delete(`${parseInt(idEmpresa, 10)}:${phone}`);
}

module.exports = { fetchOrdersByPhone, invalidate, _state: { cache } };

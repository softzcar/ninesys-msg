/**
 * businessHoursClient.js
 *
 * Cliente HTTP para el endpoint interno de ninesys-api que devuelve el
 * horario laboral de una empresa (Fase D.3).
 *
 * Endpoint: GET {API_URL}/internal/business-hours
 * Header:   Authorization: {id_empresa}    ← convención del resto de la app
 *
 * Cache en memoria con TTL: los horarios casi no cambian y evitamos golpear
 * ninesys-api desde el loop de timeout cada minuto por cada tenant activo.
 *
 * Contrato de retorno de fetchBusinessHours():
 *   - Éxito (200): devuelve el objeto horario tal cual lo devuelve la API:
 *     { horaInicioManana, horaFinManana, horaInicioTarde, horaFinTarde, diasLaborales }
 *     Las horas son decimales (8.5 = 08:30). diasLaborales es array de ints.
 *   - Error 4xx/5xx o red caída:
 *     * Si hay valor previo cacheado (aunque esté stale), lo devolvemos con
 *       la bandera `{ _stale: true }` para que el caller pueda loguear.
 *     * Si NO hay cache previo, devolvemos null para que el loop de timeout
 *       NO libere nada por error (failsafe crítico).
 *
 * Esto NO lanza excepciones — el caller no tiene que hacer try/catch.
 */

const axios = require('axios');
const log = require('./logger').createLogger('businessHoursClient');

const API_URL = process.env.API_URL;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutos

if (!API_URL) {
    log.warn('API_URL no está definida en .env');
}

const http = axios.create({
    baseURL: API_URL,
    timeout: 5000,
    headers: { Accept: 'application/json' },
});

// { [idEmpresa]: { value, fetchedAt } }
const cache = new Map();

/**
 * Obtiene el horario laboral de una empresa. No lanza excepciones.
 *
 * @param {number} idEmpresa
 * @returns {Promise<object|null>} horario laboral o null si imposible de resolver.
 */
async function fetchBusinessHours(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) {
        log.warn({ idEmpresa }, 'id_empresa inválido — no se consulta');
        return null;
    }

    // Cache hit fresco
    const entry = cache.get(id);
    const now = Date.now();
    if (entry && now - entry.fetchedAt < CACHE_TTL_MS) {
        return entry.value;
    }

    // Miss o stale → pedir a la API
    try {
        const res = await http.get('/internal/business-hours', {
            headers: { Authorization: String(id) },
        });
        const hours = res.data?.horario_laboral;
        if (!hours || typeof hours !== 'object') {
            log.warn({ tenantId: id, body: res.data }, 'Respuesta 200 sin horario_laboral utilizable');
            return entry ? { ...entry.value, _stale: true } : null;
        }
        cache.set(id, { value: hours, fetchedAt: now });
        return hours;
    } catch (err) {
        const status = err.response?.status;
        const reason = err.response?.data?.reason || err.response?.data?.error || err.code || err.message;
        log.warn(
            { tenantId: id, status, reason },
            'fetchBusinessHours falló — usando cache stale si existe'
        );
        if (entry) return { ...entry.value, _stale: true };
        return null;
    }
}

/**
 * Invalida el cache de un tenant (o de todos si se omite idEmpresa).
 * Útil cuando el admin actualiza los horarios y queremos reflejarlo ya.
 */
function invalidate(idEmpresa) {
    if (idEmpresa === undefined) {
        cache.clear();
        return;
    }
    cache.delete(parseInt(idEmpresa, 10));
}

module.exports = {
    fetchBusinessHours,
    invalidate,
    _state: { cache },
};

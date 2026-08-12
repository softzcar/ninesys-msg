/**
 * credentialsClient.js
 *
 * Cliente para el endpoint interno de ninesys-api que resuelve las
 * credenciales MySQL/PostgreSQL de cada empresa (api_emp_{id_empresa}).
 *
 * Endpoint: GET {API_URL}/internal/db-credentials/{id_empresa}
 * Header:   X-Internal-Token: {MSG_SERVICE_INTERNAL_TOKEN}
 */

const axios = require('axios');
const log = require('../lib/logger').createLogger('credentialsClient');

function getHttpClient() {
    const baseURL = process.env.API_URL || 'https://api.nineteengreen.com';
    const token = process.env.MSG_SERVICE_INTERNAL_TOKEN || '';

    if (!process.env.API_URL) {
        log.warn('API_URL no está definida en .env');
    }
    if (!token) {
        log.warn('MSG_SERVICE_INTERNAL_TOKEN no está definida en .env');
    }

    return axios.create({
        baseURL,
        timeout: 5000,
        headers: {
            'X-Internal-Token': token,
            'Accept': 'application/json',
        },
    });
}

/**
 * Verifica conectividad y validez del token contra ninesys-api.
 * Devuelve true si responde 200, lanza error en caso contrario.
 */
async function ping() {
    const http = getHttpClient();
    const res = await http.get('/internal/ping');
    if (res.data && res.data.ok === true) return true;
    throw new Error(`ping inesperado: ${JSON.stringify(res.data)}`);
}

/**
 * Obtiene las credenciales de conexión de una empresa.
 *
 * @param {number} idEmpresa
 * @returns {Promise<{id_empresa, nombre, db_host, db_user, db_password, db_name, db_driver, db_port}>}
 */
async function fetchCredentials(idEmpresa) {
    const id = parseInt(idEmpresa, 10);
    if (!Number.isInteger(id) || id <= 0) {
        const e = new Error(`id_empresa inválido: ${idEmpresa}`);
        e.status = 400;
        throw e;
    }

    try {
        const http = getHttpClient();
        const res = await http.get(`/internal/db-credentials/${id}`);
        return res.data;
    } catch (err) {
        if (err.response) {
            const e = new Error(
                `ninesys-api ${err.response.status} para empresa ${id}: ${
                    err.response.data?.message || err.response.statusText
                }`
            );
            e.status = err.response.status;
            e.body = err.response.data;
            throw e;
        }
        throw err;
    }
}

module.exports = { ping, fetchCredentials };

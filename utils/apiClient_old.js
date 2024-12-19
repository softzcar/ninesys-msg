// apiClient.js
const axios = require('axios');

class ApiClient {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
    }

    async request(method, endpoint, data = null) {
        try {
            const url = `${this.baseUrl}${endpoint}`;
            const options = {
                method,
                url,
                /* headers: {
                    'Content-Type': 'application/json'
                }, */
                data
            };

            // Si el método es GET, eliminamos el campo data, ya que no es necesario
            if (method.toLowerCase() === 'get') {
                delete options.data;
            }

            // Hacer la solicitud HTTP
            const response = await axios(options);
            return response.data;  // Devolvemos la respuesta del servidor
        } catch (error) {
            console.error('Error en la solicitud:', error.response ? error.response.data : error.message);
            throw new Error('Error en la comunicación con la API principal.');
        }
    }
}

module.exports = ApiClient;

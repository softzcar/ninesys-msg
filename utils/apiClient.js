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
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'  // Cambiar el tipo de contenido según lo que la API espera
                },
            };

            // Si el método es GET, usamos 'params' en lugar de 'data'
            if (method.toLowerCase() === 'get') {
                options.params = data;
            } else {
                options.data = data;
            }

            // Hacer la solicitud HTTP
            const response = await axios(options);
            return response.data;  // Devolvemos la respuesta del servidor
        } catch (error) {
            // Imprimir el mensaje de error detallado
            console.error('Error en la solicitud:', error.response ? error.response.data : error.message);
            throw new Error('Error en la comunicación con la API principal.');
        }
    }
}

module.exports = ApiClient;

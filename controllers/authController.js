const jwt = require('jsonwebtoken');
const ApiClient = require('../utils/apiClient'); // Importa la clase ApiClient
const apiUrl = process.env.API_URL; // La URL de la API principal

exports.verifyCredentials = async (req, res) => {
    const { username, password } = req.body;

    try {
        // Crea una instancia de ApiClient
        const client = new ApiClient(apiUrl);

        // Realiza la solicitud a la API principal para verificar las credenciales
        const data = new URLSearchParams();
        data.set('username', username);
        data.set('password', password);

        const response = await client.request('POST', '/verify-credentials', data);

        if (response) {
            // Verificamos que tenga acceso
            if (response.access === false) {
                res.status(401).json({ error: 'Usted no tiene acceso a este sistema, debe ser Administrador', resp: JSON.stringify(response) });
            } else {
                // Asegúrate de que la clave secreta está definida
                if (!process.env.JWT_SECRET) {
                    throw new Error('JWT_SECRET no está definido en las variables de entorno');
                }

                // Generar el token en un bloque try-catch
                try {
                    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '1h' });
                    res.status(200).json({ token });
                } catch (tokenError) {
                    console.error('Error al generar el token:', tokenError);
                    res.status(500).json({ message: 'Error al generar el token', error: tokenError });
                }
            }
        } else {
            res.status(500).json({ msg: 'Ocurrió un error al obtener una respuesta del servidor', error: response });
        }
    } catch (error) {
        console.error('Error al verificar las credenciales:', JSON.stringify(error));
        res.status(500).json({ message: 'Error en la verificación de credenciales', error: error });
    }
};

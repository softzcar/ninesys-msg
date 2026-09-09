const jwt = require('jsonwebtoken');
const ApiClient = require('../utils/apiClient'); // Importa la clase ApiClient
const apiUrl = process.env.API_URL; // La URL de la API principal
const log = require('../src/lib/logger').createLogger('authController');

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
                    log.error({ err: tokenError }, 'Error al generar el token');
                    res.status(500).json({ message: 'Error al generar el token', error: tokenError });
                }
            }
        } else {
            res.status(500).json({ msg: 'Ocurrió un error al obtener una respuesta del servidor', error: response });
        }
    } catch (error) {
        log.error({ err: error }, 'Error al verificar las credenciales');
        res.status(500).json({ message: 'Error en la verificación de credenciales', error: error });
    }
};

exports.loginManager = (req, res) => {
    const { username, password } = req.body;

    // Antes comparaba contra 'admin'/'Ninesys@2024' hardcodeado en el código
    // -- la misma cadena terminó publicada en el bundle JS público de
    // app_multi (nuxt.config.js) porque el frontend necesitaba conocerla
    // para pedir su propio token (auditoría de seguridad 2026-09-09). Ahora
    // se compara contra variables de entorno, con comparación de tiempo
    // constante (mismo criterio que hash_equals en el lado PHP).
    const { timingSafeEqual } = require('crypto');
    const safeCompare = (a, b) => {
        const bufA = Buffer.from(String(a));
        const bufB = Buffer.from(String(b));
        return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
    };
    const expectedUser = process.env.WS_MANAGER_USERNAME || '';
    const expectedPass = process.env.WS_MANAGER_PASSWORD || '';
    const credencialesValidas = expectedUser !== '' && expectedPass !== ''
        && safeCompare(username || '', expectedUser)
        && safeCompare(password || '', expectedPass);

    if (credencialesValidas) {
        try {
            if (!process.env.JWT_SECRET) {
                throw new Error('JWT_SECRET no está definido en las variables de entorno');
            }
            const token = jwt.sign({ user: 'admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
            res.status(200).json({ token });
        } catch (error) {
            log.error({ err: error }, 'Error al generar el token para el gestor');
            res.status(500).json({ message: 'Error interno al generar el token.' });
        }
    } else {
        res.status(401).json({ message: 'Credenciales incorrectas.' });
    }
};

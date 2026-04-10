/* // middleware/authenticateToken.js
const jwt = require("jsonwebtoken")

module.exports = (req, res, next) => {
    const authHeader = req.headers.authorization
    const token = authHeader && authHeader.split(" ")[1]

    if (!token) {
        return res
            .status(401)
            .json({ message: "Acceso denegado. Token no proporcionado." })
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res
                .status(403)
                .json({ message: "Token inválido o expirado." })
        }
        req.user = user // Adjuntar la información del usuario al objeto de solicitud
        next()
    })
} */

const jwt = require("jsonwebtoken")
const log = require('../src/lib/logger').createLogger('authenticateToken');

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(' ')[1]; // Extraer el token del prefijo 'Bearer'

    if (!token) {
        return res.status(401).json({ message: "Token no proporcionado" });
    }

    // Verificar el token
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            (req.log || log).warn({ err }, 'Token NO válido');
            return res.status(403).json({ message: "Token no válido" });
        }
        ;(req.log || log).debug('Token válido');

        req.user = user // Guardar los datos del usuario para futuros usos
        next()
    })
}

module.exports = authenticateToken

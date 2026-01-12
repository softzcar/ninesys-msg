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

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(' ')[1]; // Extraer el token del prefijo 'Bearer'

    if (!token) {
        return res.status(401).json({ message: "Token no proporcionado" });
    }

    // Verificar el token
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            console.log("Token NO válido", token)
            return res.status(403).json({ message: "Token no válido" })
        } else {
            console.log("Token válido", token)
        }

        req.user = user // Guardar los datos del usuario para futuros usos
        next()
    })
}

module.exports = authenticateToken

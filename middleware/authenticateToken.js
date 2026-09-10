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

// Auditoría de seguridad 2026-09-10 (hallazgos C5/C6, ver
// [[project_fase_seguridad_pendiente]]): antes validaba solo contra
// JWT_SECRET propio de msg_ninesys, emitido por un login con credencial de
// admin compartida que vivía en el bundle público de app_multi
// (nuxt.config.js). Ahora hay DOS llamadores legítimos y estructuralmente
// distintos, no una migración de uno a otro:
//   1) app_multi (navegador, sesión de un usuario real) -- manda el mismo
//      JWT de sesión que emite ninesys-api en /login (secreto compartido
//      servidor-a-servidor, NINESYS_API_JWT_SECRET, NUNCA visible en el
//      navegador). Trae id_empresa real -- se verifica que coincida con el
//      :companyId de la ruta (antes cualquier usuario válido podía operar
//      el WhatsApp de cualquier empresa).
//   2) ninesys-api server-a-servidor (WhatsAppAPIClient, app/lib/whatsapp.php
//      -- notificaciones automáticas: recuperación de clave, avisos de
//      orden, CRM) -- sigue logueándose con loginManager() y trae un JWT
//      firmado con el JWT_SECRET propio de msg_ninesys, sin id_empresa (no
//      es una sesión de usuario). Se valida como antes, sin scope de
//      empresa -- este llamador es de confianza total, no una migración
//      pendiente de retirar.
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(' ')[1]; // Extraer el token del prefijo 'Bearer'

    if (!token) {
        return res.status(401).json({ message: "Token no proporcionado" });
    }

    jwt.verify(token, process.env.NINESYS_API_JWT_SECRET, (err, sessionUser) => {
        if (!err) {
            if (req.params.companyId && String(sessionUser.id_empresa) !== String(req.params.companyId)) {
                (req.log || log).warn({ tokenEmpresa: sessionUser.id_empresa, companyId: req.params.companyId }, 'Token de sesión válido pero de otra empresa');
                return res.status(403).json({ message: "No tiene permiso para operar esta empresa." });
            }
            (req.log || log).debug('Token de sesión válido');
            req.user = sessionUser;
            return next();
        }

        // No es un JWT de sesión válido -- probar el token de servicio
        // (WhatsAppAPIClient, ver arriba).
        jwt.verify(token, process.env.JWT_SECRET, (err2, legacyUser) => {
            if (err2) {
                (req.log || log).warn({ err: err2 }, 'Token NO válido (ni sesión ni servicio)');
                return res.status(403).json({ message: "Token no válido" });
            }
            (req.log || log).debug('Token de servicio válido');
            req.user = legacyUser;
            next();
        });
    })
}

module.exports = authenticateToken

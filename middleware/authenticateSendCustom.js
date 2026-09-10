const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const log = require('../src/lib/logger').createLogger('authenticateSendCustom');

function tokensMatch(provided, expected) {
    if (!provided || !expected) return false;
    const bufProvided = Buffer.from(provided);
    const bufExpected = Buffer.from(expected);
    if (bufProvided.length !== bufExpected.length) return false;
    return crypto.timingSafeEqual(bufProvided, bufExpected);
}

// Autoriza POST /send-message-custom/:companyId con UNA de tres credenciales:
//   1) header X-19print-Token == DTF_APP_TOKEN -- integración dedicada de
//      19print_app (dtf.nineteencustom.com), sin login/JWT de por medio.
//   2) el JWT de sesión de ninesys-api (app_multi, navegador) -- ver
//      authenticateToken.js para el detalle del secreto compartido
//      (auditoría de seguridad 2026-09-10, [[project_fase_seguridad_pendiente]]).
//   3) el JWT de servicio propio de msg_ninesys (WhatsAppAPIClient,
//      ninesys-api server-a-servidor, mismo caso que authenticateToken.js).
// Antes de este middleware la ruta no tenía NINGÚN chequeo de auth.
module.exports = function authenticateSendCustom(req, res, next) {
    const dtfToken = req.headers['x-19print-token'];
    if (tokensMatch(dtfToken, process.env.DTF_APP_TOKEN)) {
        req.caller = '19print';
        return next();
    }

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: "Token no proporcionado" });
    }

    jwt.verify(token, process.env.NINESYS_API_JWT_SECRET, (err, sessionUser) => {
        if (!err) {
            log.debug('Token de sesión válido');
            req.user = sessionUser;
            return next();
        }

        jwt.verify(token, process.env.JWT_SECRET, (err2, legacyUser) => {
            if (err2) {
                log.warn({ err: err2 }, 'Token NO válido (ni sesión ni servicio)');
                return res.status(403).json({ message: "Token no válido" });
            }
            log.debug('Token de servicio válido');
            req.user = legacyUser;
            next();
        });
    });
};

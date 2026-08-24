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

// Autoriza POST /send-message-custom/:companyId con UNA de dos credenciales:
//   1) header X-19print-Token == DTF_APP_TOKEN -- integración dedicada de
//      19print_app (dtf.nineteencustom.com), sin login/JWT de por medio.
//   2) el mismo JWT de siempre (authenticateToken) -- app_multi ya manda
//      este header en TODAS sus llamadas via $wsApi (ver
//      app_multi/plugins/whatsapp.js), aunque esta ruta nunca lo exigió;
//      esto deja su comportamiento intacto.
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

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            log.warn({ err }, 'Token NO válido');
            return res.status(403).json({ message: "Token no válido" });
        }
        log.debug('Token válido');
        req.user = user;
        next();
    });
};

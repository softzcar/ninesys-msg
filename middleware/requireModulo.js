// middleware/requireModulo.js
//
// Port de perteneceAModulo() de ninesys-api (app/lib/AuthzHelper.php) para
// rutas que sólo deben usar empleados de un módulo (p.ej. 1 = Administración).
// Va DESPUÉS de authenticateToken y exige un JWT de SESIÓN (con id_empresa):
// el token de servicio de ninesys-api no representa a una persona y no pasa.
// Misma regla que la API: acceso === 1 pasa; si no, el id del módulo debe
// estar en el claim `modulos` del JWT.
const log = require('../src/lib/logger').createLogger('requireModulo');

module.exports = (idModulo) => (req, res, next) => {
    const user = req.user || {};
    if (!user.id_empresa || !user.id_usuario) {
        return res.status(403).json({ message: 'Requiere una sesión de usuario.' });
    }
    if (Number(user.acceso) === 1) return next();
    const modulos = Array.isArray(user.modulos) ? user.modulos.map(Number) : [];
    if (!modulos.includes(Number(idModulo))) {
        (req.log || log).warn({ idUsuario: user.id_usuario, idModulo }, 'Usuario fuera del módulo requerido');
        return res.status(403).json({ message: 'No pertenece al módulo correspondiente a esta acción.' });
    }
    next();
};

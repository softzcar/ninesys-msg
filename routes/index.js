const express = require("express");
const cors = require('cors');
const pm2 = require('pm2'); // Mantenemos pm2 si la ruta de reinicio del servidor es necesaria

const router = express.Router();

// Configuración más segura para permitir solo peticiones desde tu frontend (ajusta 'origin' según tu necesidad)
const corsOptions = {
    origin: '*', //< --Comodín para permitir cualquier origen
};
/* const corsOptions = {
    origin: 'http://localhost:3005', // Reemplaza con el origen de tu frontend en producción
}; */
router.use(cors(corsOptions));

// Importamos solo las funciones necesarias del controlador
const {
    getSessionInfo,
    showQRCode, // Para la ruta que muestra la imagen HTML
    showQRCodeBasic, // Para la ruta que devuelve el base64 JSON
    sendMessage,
    sendMessageCustom,
    sendTemplateMessage,
    sendDirectMessage,
    getConnectedClients,
    getChatsByCompanyId,
    restartClientByCompanyId,
    disconnectClientByCompanyId,
    deleteClientByCompanyId, // Importar la nueva función
    // initializeClient ya no se importa aquí porque se usa internamente en el controlador
} = require("../controllers/whatsappController");
const authController = require("../controllers/authController");
const authenticateToken = require("../middleware/authenticateToken");

// Ruta principal
router.get("/", (req, res) => {
    const html = `
        <body style="background-color: #333; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; font-family: sans-serif;">
            <div style="text-align: center;">
                <h2 style="color: white;">MSG ninesys</h2>
                <a href="/manager.html" style="color: #ccc; text-decoration: none;">administrar</a>
            </div>
        </body>
    `;
    res.send(html);
});

/**
 * Endpoint para el login del gestor de conexiones
 */
router.post("/login", authController.loginManager);

/**
 * Endpoint para obtener el estado del servidor desde PM2
 */
router.get("/server-status", authenticateToken, (req, res) => {
    pm2.describe('ntmsg-app', (err, processDescription) => {
        if (err) {
            console.error('Error al obtener descripción de PM2:', err);
            return res.status(500).json({ error: 'Error al obtener datos del servidor.' });
        }
        if (processDescription && processDescription.length > 0) {
            const proc = processDescription[0];
            const status = proc.pm2_env.status;
            const cpu = proc.monit.cpu || 0;
            const memory = proc.monit.memory || 0;

            res.status(200).json({
                status: status,
                cpu: cpu,
                memory: (memory / 1024 / 1024).toFixed(2), // Convertir bytes a MB
            });
        } else {
            res.status(404).json({ status: 'offline', message: 'Proceso no encontrado en PM2.' });
        }
    });
});

/**
 * Obtener la lista de todos los clientes y su estatus de conectado
 */
router.get("/connected-clients", authenticateToken, getConnectedClients);

/**
 * Obtenr los chats con el último mensase para un cliente
 */
router.get("/chats/:companyId", authenticateToken, getChatsByCompanyId);

/**
 * Reiniciar servicio para un cliente especifico (POST para acciones que cambian estado)
 */
router.post("/restart/:companyId", authenticateToken, restartClientByCompanyId);

/**
 * Desconectar servicio para un cliente especifico (DELETE para acciones de eliminación/desconexión)
 */
router.delete("/disconnect/:companyId", authenticateToken, disconnectClientByCompanyId);

/**
 * Eliminar por completo un cliente (sesión y datos en memoria)
 */
router.delete("/client/:companyId", authenticateToken, deleteClientByCompanyId);

/**
 * Restart Server usando PM2 (POST para acciones que cambian estado del servidor)
 */
router.post('/restart-server', authenticateToken, (req, res) => {
    console.log('Recibida petición para reiniciar el servidor usando PM2.');

    pm2.connect(err => {
        if (err) {
            console.error('Error al conectar con PM2:', err);
            return res.status(500).json({ error: 'Error al conectar con el administrador de procesos.' });
        }

        // 'ntmsg-app' es el nombre con el que registraste tu aplicación en PM2
        pm2.restart('ntmsg-app', (err, proc) => {
            pm2.disconnect(); // Desconectar de PM2 después de la operación
            if (err) {
                console.error('Error al reiniciar la aplicación con PM2:', err);
                return res.status(500).json({ error: 'Error al reiniciar la aplicación con PM2.' });
            }
            // La respuesta se envía inmediatamente después de solicitar el reinicio a PM2
            res.status(200).json({ message: 'Se ha solicitado el reinicio de la aplicación a través de PM2.' });
        });
    });
});

/**
 * Obtener informacion de cliente por ID (estado, QR si aplica, etc.)
 */
router.get("/session-info/:companyId", authenticateToken, async (req, res) => {
    const { companyId } = req.params;
    try {
        // getSessionInfo ya maneja la inicialización si el cliente no existe y la espera
        const sessionInfo = await getSessionInfo(companyId);
        if (sessionInfo.error) {
            // Si getSessionInfo devuelve un error explícito, lo reportamos con un código 500
            return res.status(500).json(sessionInfo);
        }
        res.status(200).json(sessionInfo); // Enviar siempre JSON con el estado
    } catch (error) {
        console.error(`Error en ruta /session-info/${companyId}:`, error);
        res.status(500).json({
            message: "Error al obtener información de la sesión",
            error: error.message
        });
    }
});

/**
 * Página para indicar que no hay QR (ejemplo básico si tienes nocode.html)
 */
router.get("/noqr", (req, res) => {
    res.sendFile("nocode.html", { root: "./public" });
});

/**
 * Obtener base64 del codigo QR por ID de Cliente en formato JSON
 */
router.get("/qr/64/:companyId", authenticateToken, (req, res) => {
    const { companyId } = req.params;
    const qrCodeBase64 = showQRCodeBasic(companyId); // Usamos la función utility que retorna solo el base64

    if (qrCodeBase64 && qrCodeBase64.startsWith('data:image/png;base64,')) {
        res.status(200).json({ qr: qrCodeBase64 }); // Enviar el base64 en un objeto JSON
    } else {
        // Si no hay QR disponible (cliente listo, error, o no inicializado/esperando)
        res.status(404).json({ message: qrCodeBase64 }); // Enviar el mensaje de estado en JSON
    }
});

/**
 * Obtener la imágen del codigo QR por ID de Cliente (en formato HTML para mostrar en navegador)
 */
router.get("/qr/:companyId", authenticateToken, showQRCode); // showQRCode ya maneja req, res

/**
 * Enviar mensaje básico (POST)
 */
router.post("/send-message-basic/:companyId", sendMessage); // sendMessage ya maneja req, res

/**
 * Enviar mensaje personalizado, sin usar templates
 */
router.post("/send-message-custom/:companyId", sendMessageCustom); // sendMessage ya maneja req, res

/**
 * Enviar mensaje usando plantilla (POST)
 */
router.post("/send-message/:companyId", sendTemplateMessage); // sendTemplateMessage ya maneja req, res

// --- NUEVA RUTA PARA ENVIAR MENSAJE DIRECTO ---
/**
 * @route POST /send-direct-message/:companyId
 * @description Envía un mensaje directo a un número de teléfono específico.
 * @access public (o protegido, según tu configuración de autenticación/autorización)
 * @param {string} companyId - El ID de la compañía (instancia de WhatsApp).
 * @body {string} phone - El número de teléfono del destinatario (sin @c.us).
 * @body {string} message - El contenido del mensaje a enviar.
 * @returns {object} 200 - Mensaje enviado exitosamente.
 * @returns {object} 400 - Faltan parámetros o son inválidos.
 * @returns {object} 503 - Cliente de WhatsApp no listo.
 * @returns {object} 500 - Error interno del servidor.
 */
router.post("/send-direct-message/:companyId", sendDirectMessage);


// Ruta de prueba simple
router.post("/test-recibir", (req, res) => {
    console.log("Received test data:", req.body);
    res.status(200).json({ received: req.body, status: "ok" });
});

module.exports = router;

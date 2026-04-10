const express = require("express");
const cors = require('cors');
const pm2 = require('pm2'); // Mantenemos pm2 si la ruta de reinicio del servidor es necesaria
const log = require('../src/lib/logger').createLogger('routes');

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
    getConversationMessages,
    markConversationRead,
    getAiSettings,
    updateAiSettings,
    toggleAiGlobal,
    toggleAiConversation,
    setConversationMode,
    assignConversation,
    releaseConversation,
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

// ---------------------------------------------------------------------------
// Observabilidad (Fase 9.4): /health, /ready, /metrics
// Sin auth: pensados para probes de PM2/k8s/Prometheus. No exponen datos
// sensibles (solo conteos y estados derivados).
// ---------------------------------------------------------------------------

const waManager = require('../src/services/waManager');
const aiService = require('../src/services/aiService');

/**
 * Liveness probe. Responde 200 mientras el proceso esté vivo y el event
 * loop no esté saturado. No verifica dependencias externas (eso es /ready).
 */
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'msg_ninesys',
        uptime_s: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
    });
});

/**
 * Readiness probe. Devuelve 200 si el servicio está apto para recibir
 * tráfico, 503 en caso contrario. Criterios:
 *   - circuit breaker de Gemini NO abierto (si abierto, las auto-respuestas
 *     IA fallarían; el servicio sigue funcional para mensajes manuales
 *     pero lo marcamos como degraded).
 *   - al menos una sesión Baileys existe y no está en estado DEGRADED
 *     terminal (si no hay sesiones todavía, devolvemos ready=true igual
 *     porque las sesiones se crean lazy).
 */
router.get('/ready', (req, res) => {
    const checks = {};

    const breaker = aiService.getBreakerState();
    checks.ai_breaker = {
        state: breaker.state,
        ok: breaker.state !== 'open',
    };

    const sessions = waManager.listSessions();
    const degraded = sessions.filter((s) => s.status_detail === 'DEGRADED');
    checks.wa_sessions = {
        total: sessions.length,
        ready: sessions.filter((s) => s.whatsapp_ready).length,
        degraded: degraded.length,
        ok: degraded.length === 0,
    };

    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ready' : 'degraded',
        checks,
        timestamp: new Date().toISOString(),
    });
});

/**
 * Métricas estilo Prometheus (text/plain; version=0.0.4).
 * Expone: uptime, memoria del proceso, sesiones Baileys por estado,
 * estado del breaker de Gemini.
 */
router.get('/metrics', (req, res) => {
    const lines = [];
    const push = (help, type, name, value, labels = '') => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
        lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    };

    // Proceso
    push('Uptime del proceso en segundos', 'gauge',
        'msg_ninesys_process_uptime_seconds', process.uptime().toFixed(0));

    const mem = process.memoryUsage();
    lines.push('# HELP msg_ninesys_process_memory_bytes Memoria del proceso Node en bytes');
    lines.push('# TYPE msg_ninesys_process_memory_bytes gauge');
    lines.push(`msg_ninesys_process_memory_bytes{type="rss"} ${mem.rss}`);
    lines.push(`msg_ninesys_process_memory_bytes{type="heap_used"} ${mem.heapUsed}`);
    lines.push(`msg_ninesys_process_memory_bytes{type="heap_total"} ${mem.heapTotal}`);
    lines.push(`msg_ninesys_process_memory_bytes{type="external"} ${mem.external}`);

    // Sesiones Baileys agrupadas por estado
    const sessions = waManager.listSessions();
    const byStatus = {};
    for (const s of sessions) {
        const st = s.status_detail || 'UNKNOWN';
        byStatus[st] = (byStatus[st] || 0) + 1;
    }
    lines.push('# HELP msg_ninesys_wa_sessions Sesiones Baileys agrupadas por estado');
    lines.push('# TYPE msg_ninesys_wa_sessions gauge');
    if (Object.keys(byStatus).length === 0) {
        lines.push(`msg_ninesys_wa_sessions{status="NONE"} 0`);
    } else {
        for (const [status, count] of Object.entries(byStatus)) {
            lines.push(`msg_ninesys_wa_sessions{status="${status}"} ${count}`);
        }
    }
    push('Total de sesiones registradas en memoria', 'gauge',
        'msg_ninesys_wa_sessions_total', sessions.length);

    // Circuit breaker Gemini
    const breaker = aiService.getBreakerState();
    const cbStateNum = { closed: 0, 'half-open': 1, open: 2 }[breaker.state] ?? -1;
    push('Estado del circuit breaker de Gemini (0=closed, 1=half-open, 2=open)',
        'gauge', 'msg_ninesys_ai_breaker_state', cbStateNum);
    push('Fallos consecutivos acumulados en el breaker de Gemini', 'gauge',
        'msg_ninesys_ai_breaker_failures', breaker.failures);
    push('Milisegundos restantes antes de que el breaker pase a half-open',
        'gauge', 'msg_ninesys_ai_breaker_cooldown_ms', breaker.cooldownRemainingMs);

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(lines.join('\n') + '\n');
});


/**
 * Endpoint para obtener el estado del servidor desde PM2
 */
router.get("/server-status", authenticateToken, (req, res) => {
    pm2.describe('ntmsg-app', (err, processDescription) => {
        if (err) {
            log.error({ err }, 'Error al obtener descripción de PM2');
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
 * Fase 6 — Endpoints aditivos para conversaciones
 */
router.get("/conversations/:companyId/:jid/messages", authenticateToken, getConversationMessages);
router.post("/conversations/:companyId/:jid/read", authenticateToken, markConversationRead);

/**
 * Fase 8 — Control de IA / handoff
 */
router.get("/ai/settings/:companyId", authenticateToken, getAiSettings);
router.put("/ai/settings/:companyId", authenticateToken, updateAiSettings);
router.post("/ai/toggle/:companyId", authenticateToken, toggleAiGlobal);
router.post("/conversations/:companyId/:jid/ai/toggle", authenticateToken, toggleAiConversation);
router.post("/conversations/:companyId/:jid/mode", authenticateToken, setConversationMode);
router.post("/conversations/:companyId/:jid/assign", authenticateToken, assignConversation);
router.post("/conversations/:companyId/:jid/release", authenticateToken, releaseConversation);

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
    log.info('Petición de reinicio del servidor (PM2)');

    pm2.connect(err => {
        if (err) {
            log.error({ err }, 'Error al conectar con PM2');
            return res.status(500).json({ error: 'Error al conectar con el administrador de procesos.' });
        }

        // 'ntmsg-app' es el nombre con el que registraste tu aplicación en PM2
        pm2.restart('ntmsg-app', (err, proc) => {
            pm2.disconnect(); // Desconectar de PM2 después de la operación
            if (err) {
                log.error({ err }, 'Error al reiniciar la aplicación con PM2');
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
        log.error({ err: error, tenantId: companyId }, 'Error en /session-info');
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
    log.debug({ body: req.body }, 'Received test data');
    res.status(200).json({ received: req.body, status: "ok" });
});


/**
 * Endpoint simple para verificar estado sin autenticación (solo para icono del frontend)
 */
router.get("/ws-info/:companyId", async (req, res) => {
    const { companyId } = req.params;
    try {
        const { getClientStatus } = require("../controllers/whatsappController");
        const status = getClientStatus(companyId);
        res.status(200).json(status);
    } catch (error) {
        log.error({ err: error, tenantId: companyId }, 'Error en /ws-info');
        res.status(500).json({
            status: 'ERROR',
            ws_ready: false,
            message: 'Error al obtener estado'
        });
    }
});
module.exports = router;

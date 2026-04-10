require("dotenv").config();

// Aumentar el límite de listeners
process.setMaxListeners(0);

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const app = express();
const { logger } = require("./src/lib/logger");
const requestLogger = require("./src/middleware/requestLogger");
const routes = require("./routes/index");

// *** WebSocket initialization ***
const { initWebSocket } = require("./websocket");

// *** Importar la función de inicialización de sesiones ***
const { initializeAllClientsFromSessions } = require("./controllers/whatsappController");

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static(path.join(__dirname, "public")));

// Middleware para parsear el cuerpo de las peticiones
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Request ID + child logger por request (Fase 9.1).
// IMPORTANTE: debe ir DESPUÉS de bodyParser para que ya tengamos req.body
// disponible si algún handler quiere loguearlo, y ANTES de las rutas para
// que todos los handlers tengan req.log.
app.use(requestLogger);

// Usar las rutas definidas en index.js
app.use("/", routes);

const PORT = process.env.PORT || 3001;

// Crear servidor HTTP
const server = http.createServer(app);

// Inicializar WebSocket
const io = initWebSocket(server);

// Función asíncrona para iniciar la aplicación
const startApplication = async () => {
    logger.info("Iniciando proceso de carga de sesiones de WhatsApp guardadas");
    initializeAllClientsFromSessions()
        .then(() => logger.info("Proceso de inicialización de sesiones completado"))
        .catch(error => logger.error({ err: error }, "Error durante la carga de sesiones al inicio"));

    // Iniciar el servidor HTTP (ahora con WebSocket)
    server.listen(PORT, () => {
        logger.info({ port: PORT }, "Servidor corriendo (HTTP + WebSocket)");
    });
};

// Llamar a la función principal de inicio
startApplication();

// --- Graceful shutdown (Fase 9.3) ---
// PM2 manda SIGINT en reload/restart; systemd/docker mandan SIGTERM.
// Cerramos HTTP → Socket.IO → sesiones Baileys → pools MySQL, con un
// timeout duro para no quedarnos colgados si algo no responde.
const waManager = require('./src/services/waManager');
const tenantResolver = require('./src/db/tenantResolver');

let _shuttingDownApp = false;
async function gracefulShutdown(signal) {
    if (_shuttingDownApp) return;
    _shuttingDownApp = true;
    logger.info({ signal }, 'Graceful shutdown iniciado');

    const hardExit = setTimeout(() => {
        logger.error('Shutdown timeout duro (10s), forzando exit');
        process.exit(1);
    }, 10_000);
    hardExit.unref();

    try {
        // 1. Dejar de aceptar HTTP nuevo
        await new Promise((resolve) => server.close(() => resolve()));
        logger.info('HTTP server cerrado');
        // 2. Cerrar Socket.IO
        try { io.close(); } catch (_) {}
        // 3. Cerrar sesiones Baileys
        await waManager.shutdown({ timeoutMs: 4000 });
        // 4. Cerrar pools MySQL
        await tenantResolver.shutdown();
        logger.info('Graceful shutdown completado');
        process.exit(0);
    } catch (e) {
        logger.error({ err: e }, 'Error durante graceful shutdown');
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Capturar excepciones no manejadas — loguear antes de morir
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException — saliendo');
    process.exit(1);
});

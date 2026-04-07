const { Server } = require('socket.io');

let io;

const initWebSocket = (httpServer) => {
    // Lista de dominios permitidos para conectar
    const allowedOrigins = [
        "https://app.nineteencustom.com",
        "http://app.nineteencustom.com",
        "https://app.nineteengreen.com",
        "http://app.nineteengreen.com",
        "http://localhost:3000",
        "http://localhost:3001"
    ];

    io = new Server(httpServer, {
        cors: {
            origin: (origin, callback) => {
                // Permitir si no hay origen (p.ej. servidores o herramientas de terminal)

                // Manejar múltiples orígenes (separados por coma) si el proxy los duplica
                const origins = origin.split(',').map(o => o.trim());
                const matchingOrigin = origins.find(o => allowedOrigins.includes(o));

                if (matchingOrigin) {
                    callback(null, matchingOrigin);
                } else {
                    console.error(`[WS-CORS] DEBUG-CORS-BLOCKER-V2: ${origin}`);
                    callback(new Error("No permitido por CORS"));
                }
            },
            methods: ["GET", "POST"],
            credentials: true
        },
        transports: ['websocket', 'polling'],
        allowEIO3: true
    });

    io.on('connection', (socket) => {
        console.log(`[WS] Cliente conectado: ${socket.id}`);

        socket.on('subscribe', (companyId) => {
            const room = `company-${companyId}`;
            socket.join(room);
            console.log(`[WS] ${socket.id} suscrito a ${room}`);

            try {
                const { getClientStatus, initializeClient } = require('./controllers/whatsappController');
                const status = getClientStatus(companyId);

                if (status && (status.status === 'NOT_REGISTERED' || status.status === 'INITIALIZING')) {
                    // La empresa no tiene cliente en memoria: inicializar para generar QR
                    console.log(`[WS] Empresa ${companyId} sin cliente activo. Iniciando inicialización...`);
                    initializeClient(companyId);
                } else if (status) {
                    // Ya hay un cliente activo o con sesión, devolver su estado actual
                    socket.emit('status', { companyId, ...status });
                    // Si además ya hay un QR cacheado (REQUIRES_QR), re-emitirlo
                    // como evento 'qr' para los suscriptores que llegan tarde.
                    if (status.qr) {
                        socket.emit('qr', { companyId, qr: status.qr });
                    }
                }
            } catch (error) {
                console.error(`[WS] Error en subscribe para ${companyId}:`, error);
            }
        });

        socket.on('restart-client', async (companyId) => {
            console.log(`[WS] Comando 'restart-client' recibido para ${companyId}`);
            try {
                const { restartClient } = require('./controllers/whatsappController');
                await restartClient(companyId);
            } catch (error) {
                console.error(`[WS] Error reiniciando cliente ${companyId}:`, error);
                socket.emit('error', { message: error.message || 'Error al reiniciar cliente' });
            }
        });

        socket.on('disconnect-client', async (companyId) => {
            console.log(`[WS] Comando 'disconnect-client' recibido para ${companyId}`);
            try {
                const { disconnectClient, initializeClient } = require('./controllers/whatsappController');
                await disconnectClient(companyId);
                console.log(`[WS] Reinicializando cliente tras desconexión para generar nuevo QR para ${companyId}`);
                initializeClient(companyId);
            } catch (error) {
                console.error(`[WS] Error desconectando cliente ${companyId}:`, error);
                socket.emit('error', { message: error.message || 'Error al desconectar cliente' });
            }
        });

        socket.on('disconnect', (reason) => {
            console.log(`[WS] Cliente desconectado: ${socket.id} - Razón: ${reason}`);
        });

        socket.on('error', (error) => {
            console.error(`[WS] Error en socket ${socket.id}:`, error);
        });
    });

    // Inyectar io en waManager para que emita qr/ready/status/disconnected
    // a las salas company-<id>.
    const waManager = require('./src/services/waManager');
    waManager.setIo(io);
    console.log('[WS] waManager enlazado al servidor Socket.IO');

    console.log('[WS] Servidor WebSocket inicializado con CORS robusto y auto-inicialización de clientes');
    return io;
};

const emitToCompany = (companyId, event, data) => {
    if (io) {
        const room = `company-${companyId}`;
        io.to(room).emit(event, data);
        console.log(`[WS] Emitido '${event}' a ${room}`);
    } else {
        console.warn('[WS] Servidor no inicializado, no se puede emitir');
    }
};

const getIO = () => io;

module.exports = { initWebSocket, emitToCompany, getIO };

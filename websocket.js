const { Server } = require('socket.io');
const log = require('./src/lib/logger').createLogger('websocket');

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
                    log.error({ origin }, 'CORS block');
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
        log.info({ socketId: socket.id }, 'Cliente conectado');

        socket.on('subscribe', (companyId) => {
            const room = `company-${companyId}`;
            socket.join(room);
            log.info({ socketId: socket.id, room }, 'subscribe');

            try {
                const { getClientStatus, initializeClient } = require('./controllers/whatsappController');
                const status = getClientStatus(companyId);

                if (status && (status.status === 'NOT_REGISTERED' || status.status === 'INITIALIZING')) {
                    // La empresa no tiene cliente en memoria: inicializar para generar QR
                    log.info({ tenantId: companyId }, 'sin cliente activo, iniciando');
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
                log.error({ err: error, tenantId: companyId }, 'Error en subscribe');
            }
        });

        socket.on('restart-client', async (companyId) => {
            log.info({ tenantId: companyId }, "restart-client recibido");
            try {
                const { restartClient } = require('./controllers/whatsappController');
                await restartClient(companyId);
            } catch (error) {
                log.error({ err: error, tenantId: companyId }, 'Error reiniciando cliente');
                socket.emit('error', { message: error.message || 'Error al reiniciar cliente' });
            }
        });

        socket.on('disconnect-client', async (companyId) => {
            log.info({ tenantId: companyId }, "disconnect-client recibido");
            try {
                const { disconnectClient, initializeClient } = require('./controllers/whatsappController');
                await disconnectClient(companyId);
                log.info({ tenantId: companyId }, 'Reinicializando cliente tras desconexión');
                initializeClient(companyId);
            } catch (error) {
                log.error({ err: error, tenantId: companyId }, 'Error desconectando cliente');
                socket.emit('error', { message: error.message || 'Error al desconectar cliente' });
            }
        });

        socket.on('disconnect', (reason) => {
            log.info({ socketId: socket.id, reason }, 'Cliente desconectado');
        });

        socket.on('error', (error) => {
            log.error({ err: error, socketId: socket.id }, 'Error en socket');
        });
    });

    // Inyectar io en waManager para que emita qr/ready/status/disconnected
    // a las salas company-<id>.
    const waManager = require('./src/services/waManager');
    waManager.setIo(io);
    log.info('waManager enlazado al servidor Socket.IO');
    log.info('Servidor WebSocket inicializado');
    return io;
};

const emitToCompany = (companyId, event, data) => {
    if (io) {
        const room = `company-${companyId}`;
        io.to(room).emit(event, data);
        log.debug({ event, room }, 'emit');
    } else {
        log.warn('Servidor no inicializado, no se puede emitir');
    }
};

const getIO = () => io;

module.exports = { initWebSocket, emitToCompany, getIO };

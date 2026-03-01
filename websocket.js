const { Server } = require('socket.io');

let io;

const initWebSocket = (httpServer) => {
    // Lista de dominios permitidos para conectar
    const allowedOrigins = [
        "https://app.nineteencustom.com",
        "http://app.nineteencustom.com", // <--- Agregamos la versión sin S
        "https://app.nineteengreen.com",
        "http://app.nineteengreen.com",  // <--- Agregamos la versión sin S
        "http://localhost:3000",
        "http://localhost:3001"
    ];

    io = new Server(httpServer, {
        cors: {
            origin: (origin, callback) => {
                // Permitir si no hay origen (p.ej. servidores o herramientas de terminal)
                if (!origin) return callback(null, true);
                
                if (allowedOrigins.indexOf(origin) !== -1) {
                    // Si el origen está en la lista, lo aceptamos
                    callback(null, true);
                } else {
                    // Registro en consola para saber qué dominio falló
                    console.error(`[WS-CORS] Bloqueado por seguridad: ${origin}`);
                    callback(new Error("No permitido por CORS"));
                }
            },
            methods: ["GET", "POST"],
            credentials: true
        },
        transports: ['websocket', 'polling'],
        allowEIO3: true // Compatibilidad mejorada
    });

    io.on('connection', (socket) => {
        console.log(`[WS] Cliente conectado: ${socket.id}`);

        // Suscribirse a eventos de una empresa específica
        socket.on('subscribe', (companyId) => {
            const room = `company-${companyId}`;
            socket.join(room);
            console.log(`[WS] ${socket.id} suscrito a ${room}`);

            // Enviar estado inicial si existe
            try {
                const { getClientStatus } = require('./controllers/whatsappController');
                const status = getClientStatus(companyId);
                console.log(`[WS] Enviando estado inicial a ${socket.id} para ${room}:`, JSON.stringify(status));
                socket.emit('status', status);
            } catch (err) {
                console.error(`[WS] Error enviando estado para ${companyId}:`, err);
            }
        });

        socket.on('unsubscribe', (companyId) => {
            const room = `company-${companyId}`;
            socket.leave(room);
            console.log(`[WS] ${socket.id} desuscrito de ${room}`);
        });

        // --- COMANDOS VIA WEBSOCKET ---

        // Activar/Inicializar cliente de WhatsApp
        socket.on('activate', async (companyId) => {
            console.log(`[WS] Comando 'activate' recibido para ${companyId}`);
            try {
                const { initializeClient } = require('./controllers/whatsappController');
                await initializeClient(companyId, true);
            } catch (error) {
                console.error(`[WS] Error activando cliente ${companyId}:`, error);
                socket.emit('error', { message: error.message || 'Error al activar cliente' });
            }
        });

        // Reiniciar cliente de WhatsApp
        socket.on('restart', async (companyId) => {
            console.log(`[WS] Comando 'restart' recibido para ${companyId}`);
            try {
                const { restartClient } = require('./controllers/whatsappController');
                await restartClient(companyId);
            } catch (error) {
                console.error(`[WS] Error reiniciando cliente ${companyId}:`, error);
                socket.emit('error', { message: error.message || 'Error al reiniciar cliente' });
            }
        });

        // Desconectar cliente de WhatsApp
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

    console.log('[WS] Servidor WebSocket inicializado con validación de CORS');
    return io;
};

// Emitir evento a todos los clientes suscritos a una empresa
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

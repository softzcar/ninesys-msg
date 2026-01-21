const { Server } = require('socket.io');

let io;

const initWebSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: [
                "https://app.nineteencustom.com",
                "https://app.nineteengreen.com",
                "http://localhost:3000",
                "http://localhost:3001"
            ],
            methods: ["GET", "POST"],
            credentials: true
        },
        transports: ['websocket', 'polling']
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
                const { initializeClient, getClientStatus } = require('./controllers/whatsappController');
                await initializeClient(companyId);
                // El cliente emitirá eventos 'qr' o 'ready' automáticamente
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
                // El cliente emitirá eventos 'qr' o 'ready' automáticamente
            } catch (error) {
                console.error(`[WS] Error reiniciando cliente ${companyId}:`, error);
                socket.emit('error', { message: error.message || 'Error al reiniciar cliente' });
            }
        });

        // Desconectar cliente de WhatsApp
        socket.on('disconnect-client', async (companyId) => {
            console.log(`[WS] Comando 'disconnect-client' recibido para ${companyId}`);
            try {
                const { disconnectClient } = require('./controllers/whatsappController');
                await disconnectClient(companyId);
                socket.emit('status', { status: 'DISCONNECTED', ws_ready: false, qr: null });
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

    console.log('[WS] Servidor WebSocket inicializado');
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

// Obtener instancia de io (para uso externo si es necesario)
const getIO = () => io;

module.exports = { initWebSocket, emitToCompany, getIO };

/**
 * test-baileys-poc.js
 *
 * Smoke test del PoC Baileys (Fase 4). Inicializa una sesión para empresa 163,
 * imprime QR en consola, espera a que se escanee y muestra el estado READY.
 *
 * Uso (en el VPS dev, donde la BD api_emp_163 es alcanzable):
 *   node scripts/test-baileys-poc.js [idEmpresa]
 *
 * Salida esperada:
 *   1) Estado INITIALIZING
 *   2) Evento qr (QR ASCII en stdout)
 *   3) Estado READY tras el escaneo
 *   4) Cierre limpio con Ctrl+C
 */

require('dotenv').config();
const qrcodeTerminal = require('qrcode-terminal');
const waManager = require('../src/services/waManager');

const ID = parseInt(process.argv[2] || '163', 10);

// Mock mínimo de Socket.IO para capturar los eventos del manager.
const fakeIo = {
    to: (room) => ({
        emit: (event, payload) => {
            if (event === 'qr') {
                console.log(`[poc] (room=${room}) QR recibido — escanéalo:`);
                // El payload trae base64; para terminal usamos el string crudo
                // a partir del propio sock — aquí solo confirmamos recepción.
                console.log('       (base64 omitido en log; longitud=', payload.qr.length, ')');
            } else {
                console.log(`[poc] (room=${room}) ${event}`, payload);
            }
        },
    }),
};
waManager.setIo(fakeIo);

(async () => {
    try {
        console.log(`[poc] Inicializando sesión Baileys para empresa ${ID}...`);
        const session = await waManager.init(ID);

        // Engancharse directamente al sock para imprimir QR ASCII en terminal
        session.sock.ev.on('connection.update', ({ qr, connection }) => {
            if (qr) {
                console.log('[poc] Escanea este QR con WhatsApp:\n');
                qrcodeTerminal.generate(qr, { small: true });
            }
            if (connection === 'open') {
                console.log('[poc] ✅ Conectado. Estado:', waManager.getStatus(ID));
                console.log('[poc] Ctrl+C para salir.');
            }
        });
    } catch (e) {
        console.error('[poc] ❌ Error:', e);
        process.exit(1);
    }
})();

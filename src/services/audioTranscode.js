/**
 * audioTranscode.js
 *
 * Transcodificación de audio para notas de voz (PTT) de WhatsApp.
 *
 * WhatsApp espera notas de voz en contenedor Ogg con códec Opus. Los
 * navegadores modernos, sin embargo, graban a través de MediaRecorder casi
 * exclusivamente en contenedor WebM (con Opus por dentro). Si enviamos el
 * WebM tal cual a Baileys, el mensaje llega marcado como enviado pero el
 * teléfono del destinatario no lo reproduce (ni aparece la nota).
 *
 * Solución: remuxear/transcodificar con ffmpeg antes de pasar el buffer a
 * sendMessage(). Usamos ffmpeg-static (binario empacado en el npm module)
 * para no depender de que ffmpeg esté instalado en el VPS.
 */

const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const log = require('../lib/logger').createLogger('audioTranscode');

/**
 * Convierte un buffer de audio a Ogg/Opus mono 16 kbps (formato estándar de
 * notas de voz de WhatsApp). Si el códec interno ya es Opus (caso del WebM
 * grabado por MediaRecorder), ffmpeg remuxea sin re-encodear (barato); en
 * otros casos re-encodea.
 *
 * @param {Buffer} inputBuffer
 * @param {string} [inputMime]  MIME original (para log, opcional)
 * @returns {Promise<Buffer>}   Buffer Ogg/Opus listo para Baileys
 */
function toOggOpus(inputBuffer, inputMime = 'audio/webm') {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) {
            return reject(new Error('ffmpeg-static: binario no encontrado'));
        }
        if (!Buffer.isBuffer(inputBuffer) || !inputBuffer.length) {
            return reject(new Error('toOggOpus: buffer vacío'));
        }

        // Argumentos:
        //   -i pipe:0          lee de stdin
        //   -vn                descarta cualquier stream de video (WebM puede traerlo)
        //   -c:a libopus       re-encode a Opus (garantiza compatibilidad)
        //   -b:a 32k           bitrate mono bajo, típico de PTT
        //   -ac 1              canal mono
        //   -ar 48000          sample rate estándar para Opus
        //   -f ogg             contenedor de salida Ogg
        //   pipe:1             escribe a stdout
        const args = [
            '-loglevel', 'error',
            '-i', 'pipe:0',
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ac', '1',
            '-ar', '48000',
            '-f', 'ogg',
            'pipe:1',
        ];

        const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        const stdoutChunks = [];
        let stderrBuf = '';

        proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
        proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

        proc.on('error', (err) => {
            reject(new Error(`ffmpeg spawn error: ${err.message}`));
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                log.error({ code, stderr: stderrBuf.slice(0, 2000), inputMime }, 'ffmpeg transcode falló');
                return reject(new Error(`ffmpeg exit ${code}: ${stderrBuf.slice(0, 300)}`));
            }
            const out = Buffer.concat(stdoutChunks);
            if (!out.length) {
                return reject(new Error('ffmpeg: salida vacía'));
            }
            log.debug({ inBytes: inputBuffer.length, outBytes: out.length, inputMime }, 'Audio transcodificado a ogg/opus');
            resolve(out);
        });

        // Pipe del buffer de entrada por stdin
        proc.stdin.on('error', (err) => {
            // EPIPE ocurre si ffmpeg ya cerró — lo capturamos para no romper
            if (err.code !== 'EPIPE') reject(err);
        });
        proc.stdin.end(inputBuffer);
    });
}

module.exports = {
    toOggOpus,
};

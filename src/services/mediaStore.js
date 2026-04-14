/**
 * mediaStore.js
 *
 * Servicio de almacenamiento de archivos multimedia para mensajes de WhatsApp.
 * Fase B.1 — Media MVP.
 *
 * Responsabilidad: guardar en disco los archivos (imagen/audio/video/doc/sticker)
 * que llegan por Baileys o que el usuario sube desde el panel, y resolver la
 * ruta absoluta cuando hay que servir el archivo.
 *
 * Layout:
 *   <STORAGE_ROOT>/media/{companyId}/{YYYY-MM}/{waMessageId}.{ext}
 *
 * Configuración (env):
 *   MEDIA_STORAGE_ROOT  - raíz del storage. Default: <repo>/storage
 *   MEDIA_MAX_SIZE_MB   - tamaño máximo por archivo. Default: 16 (como WhatsApp)
 *   MEDIA_RETENTION_DAYS- días que se conservan los archivos. Default: 60
 */

const fs = require('fs');
const path = require('path');
const log = require('../lib/logger').createLogger('mediaStore');

const STORAGE_ROOT = process.env.MEDIA_STORAGE_ROOT
    || path.join(__dirname, '..', '..', 'storage');
const MEDIA_ROOT = path.join(STORAGE_ROOT, 'media');

const MAX_SIZE_MB = Number(process.env.MEDIA_MAX_SIZE_MB || 16);
const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

const RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS || 60);

// Mapa MIME → extensión. Cubre lo que manda/recibe WhatsApp.
// Deliberadamente pequeño: si llega algo raro usamos 'bin'.
const MIME_TO_EXT = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/zip': 'zip',
    'text/plain': 'txt',
    'text/csv': 'csv',
};

function extFromMime(mime) {
    if (!mime) return 'bin';
    const clean = String(mime).split(';')[0].trim().toLowerCase();
    return MIME_TO_EXT[clean] || MIME_TO_EXT[mime.toLowerCase()] || 'bin';
}

/**
 * Sanitiza el wa_message_id para usarlo como nombre de archivo.
 * Baileys usa IDs tipo "3EB0A7F..." o "BAE5..." — seguros. Igual aplicamos
 * whitelist por si se usan IDs locales "FAIL-xxx" con guiones/underscores.
 */
function safeId(waMessageId) {
    return String(waMessageId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function yearMonth(ts = Date.now()) {
    const d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}

/**
 * Construye la ruta absoluta donde se guarda un archivo.
 */
function resolveAbsPath(companyId, ym, fileName) {
    return path.join(MEDIA_ROOT, String(companyId), ym, fileName);
}

/**
 * Asegura que un directorio existe.
 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Guarda un buffer en el storage.
 *
 * @param {object} params
 * @param {number|string} params.companyId
 * @param {string} params.waMessageId
 * @param {Buffer} params.buffer
 * @param {string} params.mimeType
 * @param {number} [params.ts] - timestamp en segundos o milisegundos (para el bucket YYYY-MM)
 * @returns {{ relativePath: string, absPath: string, mimeType: string, size: number }}
 */
function saveBuffer({ companyId, waMessageId, buffer, mimeType, ts }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('buffer no es un Buffer válido');
    if (buffer.length > MAX_SIZE_BYTES) {
        throw new Error(`archivo excede el límite de ${MAX_SIZE_MB} MB`);
    }
    const ext = extFromMime(mimeType);
    const ym = yearMonth(ts);
    const fileName = `${safeId(waMessageId)}.${ext}`;
    const absPath = resolveAbsPath(companyId, ym, fileName);
    ensureDir(path.dirname(absPath));
    fs.writeFileSync(absPath, buffer);

    const relativePath = path.relative(MEDIA_ROOT, absPath).split(path.sep).join('/');
    return { relativePath, absPath, mimeType, size: buffer.length };
}

/**
 * Resuelve el path absoluto de un archivo a partir de su path relativo guardado
 * en wa_messages.media_url. Valida que no se salga de MEDIA_ROOT.
 */
function resolveRelative(relativePath) {
    if (!relativePath) return null;
    const safe = String(relativePath).replace(/^[\\/]+/, '');
    const abs = path.resolve(MEDIA_ROOT, safe);
    if (!abs.startsWith(path.resolve(MEDIA_ROOT) + path.sep) && abs !== path.resolve(MEDIA_ROOT)) {
        // Protección anti path-traversal
        return null;
    }
    return abs;
}

function exists(relativePath) {
    const abs = resolveRelative(relativePath);
    return !!abs && fs.existsSync(abs);
}

/**
 * Borra archivos modificados hace más de N días.
 * Devuelve estadísticas { scanned, deleted, bytes }.
 */
function cleanupOlderThan(days = RETENTION_DAYS) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const stats = { scanned: 0, deleted: 0, bytes: 0, errors: 0 };

    if (!fs.existsSync(MEDIA_ROOT)) return stats;

    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (e) {
            stats.errors++;
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                // Intentar borrar dir si quedó vacío
                try {
                    const remain = fs.readdirSync(full);
                    if (remain.length === 0) fs.rmdirSync(full);
                } catch (_) { /* best-effort */ }
            } else if (entry.isFile()) {
                stats.scanned++;
                try {
                    const st = fs.statSync(full);
                    if (st.mtimeMs < cutoff) {
                        fs.unlinkSync(full);
                        stats.deleted++;
                        stats.bytes += st.size;
                    }
                } catch (e) {
                    stats.errors++;
                }
            }
        }
    };

    walk(MEDIA_ROOT);
    log.info(stats, 'mediaStore.cleanup completado');
    return stats;
}

module.exports = {
    saveBuffer,
    resolveRelative,
    exists,
    cleanupOlderThan,
    extFromMime,
    MAX_SIZE_MB,
    MAX_SIZE_BYTES,
    RETENTION_DAYS,
    STORAGE_ROOT,
    MEDIA_ROOT,
};

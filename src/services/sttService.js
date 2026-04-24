/**
 * sttService.js
 *
 * Servicio de Speech-to-Text con OpenAI Whisper para notas de voz entrantes.
 *
 * Objetivo:
 *   Cuando un cliente envía una nota de voz (audioMessage ptt=true) a la línea
 *   del tenant, la transcribimos con Whisper y devolvemos el texto para que
 *   `aiService` (Gemini) pueda contestar como si el cliente hubiera escrito.
 *
 * Reglas de negocio (ver logs_gemini/2026-04-20_00-00-01_plan-mensajes_voz_ia_whisper.log):
 *   1. Solo notas de voz (ptt=true). Audios adjuntos "musicales" no se transcriben.
 *   2. Si la duración ≥ stt_long_audio_seconds (default 120s) → handoff a humano
 *      sin gastar Whisper.
 *   3. Si el consumo mensual del tenant ≥ stt_monthly_usd_limit → handoff.
 *   4. Si stt_enabled = 0 → skip completo (no transcribe, no handoff por STT —
 *      la red de seguridad de waManager sigue activa para audios largos).
 *   5. Idempotencia: si `wa_messages.transcript` ya tiene valor para este
 *      `wa_message_id`, no re-transcribimos (evita doble cobro en retries).
 *
 * Precio Whisper (a 2026-04): $0.006 USD / minuto, prorrateado por segundo.
 * Si cambia el precio, actualizar WHISPER_USD_PER_MINUTE y dejar anotado
 * en el log correspondiente.
 */

const fs = require('fs');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');

const mediaStore = require('./mediaStore');
const usageStore = require('./usageStore');
const log = require('../lib/logger').createLogger('sttService');

// Precio Whisper. Actualizar aquí si OpenAI lo cambia.
const WHISPER_USD_PER_MINUTE = 0.006;

const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';
const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';

// Timeout por intento. Una nota de voz de 2 min tarda típicamente 5-10s en
// transcribirse; 60s deja margen holgado sin colgar el ingest si el API
// se pone lento.
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 60_000);

// 1 retry con backoff corto. Más intentos no aportan en flujos conversacionales
// — si Whisper está caído preferimos dejar que la IA maneje "audio inentendible"
// o escalar, en vez de bloquear al cliente.
const WHISPER_RETRIES = 1;
const WHISPER_BACKOFF_MS = 800;

/**
 * Costo en USD de una transcripción de `seconds` segundos.
 */
function costUsd(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    return (s * WHISPER_USD_PER_MINUTE) / 60;
}

/**
 * Llama a Whisper y devuelve `{ text, language }`. Lanza en errores no
 * recuperables (falta de API key, archivo no encontrado). Aplica retry
 * ante fallos de red / 5xx.
 *
 * @param {object} p
 * @param {string} p.filePath  ruta absoluta al archivo de audio
 * @param {string} [p.mimeType]
 * @param {string} [p.language] hint ('es', 'en', …). Vacío = autodetect.
 */
async function transcribe({ filePath, mimeType, language }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY no configurada');
    if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`archivo de audio no encontrado: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const type = mimeType || 'audio/ogg';

    const attempt = async () => {
        // FormData + Blob son globales en Node 18+. No usamos form-data lib
        // ni streams para simplificar: las notas de voz pesan pocos KB.
        const form = new FormData();
        form.append('file', new Blob([buffer], { type }), filename);
        form.append('model', WHISPER_MODEL);
        // verbose_json nos devuelve language detectado (útil para auditoría).
        form.append('response_format', 'verbose_json');
        if (language) form.append('language', language);

        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), WHISPER_TIMEOUT_MS);
        try {
            const resp = await fetch(WHISPER_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
                signal: ac.signal,
            });
            if (!resp.ok) {
                const bodyText = await resp.text().catch(() => '');
                const err = new Error(`Whisper ${resp.status}: ${bodyText.slice(0, 300)}`);
                err.status = resp.status;
                err.retryable = resp.status >= 500 || resp.status === 429;
                throw err;
            }
            const data = await resp.json();
            return {
                text: String(data.text || '').trim(),
                language: data.language || null,
            };
        } finally {
            clearTimeout(timer);
        }
    };

    let lastErr = null;
    for (let i = 0; i <= WHISPER_RETRIES; i++) {
        try {
            return await attempt();
        } catch (e) {
            lastErr = e;
            const retryable =
                e.retryable === true ||
                e.name === 'AbortError' ||
                e.code === 'ECONNRESET' ||
                e.code === 'ETIMEDOUT' ||
                e.code === 'ENOTFOUND';
            if (i >= WHISPER_RETRIES || !retryable) break;
            await sleep(WHISPER_BACKOFF_MS * (i + 1));
        }
    }
    throw lastErr;
}

/**
 * Verifica elegibilidad y, si aplica, transcribe y persiste.
 *
 * @param {Pool}   pool
 * @param {object} ingested   lo que retorna conversationStore.ingestMessage
 *                            (se usa `message.wa_message_id`, `message.type`,
 *                            `message.media_url`, `message.media_mime`).
 * @param {object} opts
 * @param {boolean} opts.ptt          true si el audio es nota de voz (ptt=1)
 * @param {number}  opts.seconds      duración en segundos (de audioMessage.seconds)
 * @param {string}  [opts.mimeType]   override del mime (si no viene en ingested)
 * @returns {Promise<
 *   | { ok: true, text: string, language: string|null, cost_usd: number }
 *   | { ok: false, reason: string, handoff?: boolean, error?: string }
 * >}
 */
async function transcribeIfEligible(pool, ingested, opts = {}) {
    const msg = ingested?.message;
    if (!msg) return { ok: false, reason: 'no_message' };

    // Guarda 1: tipo y ptt. Audios no-ptt no se transcriben.
    if (msg.type !== 'audio' || !opts.ptt) {
        return { ok: false, reason: 'not_voice_note' };
    }

    // Guarda 2: configuración del tenant.
    const cfg = await usageStore.getTenantConfig(pool);
    if (!cfg.stt_enabled) {
        return { ok: false, reason: 'stt_disabled' };
    }

    // Guarda 3: audio largo → handoff sin gastar Whisper.
    const seconds = Number(opts.seconds) || 0;
    if (seconds >= cfg.stt_long_audio_seconds) {
        return { ok: false, reason: 'audio_too_long', handoff: true };
    }

    // Guarda 4: tope mensual alcanzado.
    const month = await usageStore.getUsageByMonth(pool);
    const whisperSpent = (month.providers.find((p) => p.provider === 'whisper') || {}).usd || 0;
    if (whisperSpent >= cfg.stt_monthly_usd_limit) {
        return { ok: false, reason: 'stt_cap_reached', handoff: true };
    }

    // Guarda 5: idempotencia. Si ya tenemos transcript para este mensaje
    // (retry externo, reprocess), no re-transcribimos ni re-cobramos.
    const waMessageId = msg.wa_message_id;
    if (!waMessageId) return { ok: false, reason: 'no_wa_message_id' };
    const [existingRows] = await pool.query(
        `SELECT transcript, transcript_lang, transcript_cost_usd
         FROM wa_messages WHERE wa_message_id = ? LIMIT 1`,
        [waMessageId]
    );
    const existing = existingRows[0];
    if (existing && existing.transcript) {
        return {
            ok: true,
            text: existing.transcript,
            language: existing.transcript_lang || null,
            cost_usd: existing.transcript_cost_usd != null
                ? Number(existing.transcript_cost_usd) : 0,
            cached: true,
        };
    }

    // Resolver path absoluto del archivo guardado por mediaStore.
    const absPath = mediaStore.resolveRelative(msg.media_url);
    if (!absPath || !fs.existsSync(absPath)) {
        const err = 'media file not found';
        await persistError(pool, waMessageId, err);
        return { ok: false, reason: 'media_missing', error: err };
    }

    // Llamar a Whisper.
    let result;
    try {
        result = await transcribe({
            filePath: absPath,
            mimeType: opts.mimeType || msg.media_mime || 'audio/ogg',
            language: cfg.stt_language || undefined,
        });
    } catch (e) {
        log.warn(
            { err: e, waMessageId, seconds },
            'Whisper falló — se deja mensaje sin transcript'
        );
        await persistError(pool, waMessageId, String(e.message || e).slice(0, 255));
        return { ok: false, reason: 'stt_error', error: e.message };
    }

    const cost = costUsd(seconds);

    // Persistir transcript en el mensaje y acumular consumo del mes.
    try {
        await pool.query(
            `UPDATE wa_messages
             SET transcript = ?, transcript_lang = ?, transcript_cost_usd = ?,
                 transcript_error = NULL
             WHERE wa_message_id = ?`,
            [result.text, result.language, cost, waMessageId]
        );
    } catch (e) {
        log.warn({ err: e, waMessageId }, 'No se pudo guardar transcript en wa_messages');
    }

    try {
        await usageStore.addUsage(pool, 'whisper', cost, 1);
    } catch (e) {
        log.warn({ err: e, waMessageId }, 'No se pudo actualizar wa_usage_monthly');
    }

    log.info(
        {
            waMessageId,
            seconds,
            lang: result.language,
            cost_usd: cost,
            chars: result.text.length,
        },
        'Nota de voz transcrita'
    );

    return {
        ok: true,
        text: result.text,
        language: result.language,
        cost_usd: cost,
    };
}

async function persistError(pool, waMessageId, errMsg) {
    try {
        await pool.query(
            `UPDATE wa_messages SET transcript_error = ? WHERE wa_message_id = ?`,
            [errMsg, waMessageId]
        );
    } catch (_) {
        // best-effort
    }
}

module.exports = {
    transcribe,
    transcribeIfEligible,
    costUsd,
    WHISPER_USD_PER_MINUTE,
};

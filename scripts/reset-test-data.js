#!/usr/bin/env node
/**
 * reset-test-data.js
 *
 * "Mesa limpia" para una sesión de pruebas: borra mensajes, conversaciones,
 * log de envíos y mapeo LID↔fono de un tenant (empresa) sin tocar la
 * configuración permanente (plantillas, settings de IA).
 *
 * Uso:
 *   node scripts/reset-test-data.js [id_empresa] [flags]
 *
 * Por defecto (soft reset) borra:
 *   - wa_messages
 *   - wa_conversations
 *   - wa_send_log
 *   - wa_lid_phone_map
 *
 * Siempre preserva:
 *   - wa_templates
 *   - wa_ai_settings
 *
 * Flags:
 *   --dry-run         Muestra cuentas actuales sin borrar nada.
 *   --yes             Omite la confirmación interactiva.
 *   --with-session    Desvincula el dispositivo (llama a DELETE /disconnect
 *                     del servicio → sock.logout() → WhatsApp remueve el
 *                     dispositivo del móvil) y resetea wa_session_state.
 *                     Si el servicio no responde, aborta — evita vaciar la
 *                     DB dejando el móvil vinculado en silencio.
 *   --skip-logout     Junto con --with-session: salta la llamada HTTP y
 *                     borra solo la DB. El móvil SEGUIRÁ mostrando el
 *                     dispositivo vinculado hasta que se quite a mano.
 *                     Útil solo si el servicio está intencionalmente caído.
 *   --with-vendors    Vacía wa_vendor_state (disponibilidad de vendedores).
 *   --with-media      Borra <STORAGE_ROOT>/media/<idEmpresa>/ del disco.
 *   --service-url=URL Base URL del servicio msg_ninesys.
 *                     Default: http://127.0.0.1:${PORT:-3000}
 *
 * IMPORTANTE: tras correr este script hay que reiniciar msg_ninesys para
 * limpiar cachés en memoria (conversationStore, lidPhoneMap,
 * assignmentStore). De lo contrario el servicio seguirá mostrando lo que
 * ya no existe en DB.
 *
 * Nota sobre conectividad: las credenciales de empresa suelen apuntar a
 * `localhost` del VPS. Si corrés este script fuera del VPS, abrí un túnel
 * SSH antes:
 *   ssh -L 3306:localhost:3306 vps-ninesys
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const tenantResolver = require('../src/db/tenantResolver');

const DEFAULT_ID_EMPRESA = 163;

// Tablas del soft reset (siempre se vacían).
const CORE_TABLES = [
    'wa_messages',
    'wa_conversations',
    'wa_send_log',
    'wa_lid_phone_map',
];

function parseArgs(argv) {
    const out = {
        idEmpresa: DEFAULT_ID_EMPRESA,
        dryRun: false,
        yes: false,
        withSession: false,
        withVendors: false,
        withMedia: false,
        skipLogout: false,
        serviceUrl: null,
    };
    for (const a of argv.slice(2)) {
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--with-session') out.withSession = true;
        else if (a === '--with-vendors') out.withVendors = true;
        else if (a === '--with-media') out.withMedia = true;
        else if (a === '--skip-logout') out.skipLogout = true;
        else if (a.startsWith('--service-url=')) out.serviceUrl = a.slice('--service-url='.length);
        else if (/^\d+$/.test(a)) out.idEmpresa = parseInt(a, 10);
        else {
            console.error(`[reset-test-data] argumento desconocido: ${a}`);
            process.exit(2);
        }
    }
    if (!out.serviceUrl) {
        const port = process.env.PORT || 3000;
        out.serviceUrl = `http://127.0.0.1:${port}`;
    }
    return out;
}

/**
 * Llama al endpoint DELETE /disconnect/:companyId del servicio para que
 * éste ejecute sock.logout() y WhatsApp desvincule el dispositivo en el
 * móvil. Firma un JWT de corta vida con JWT_SECRET del .env.
 *
 * Devuelve:
 *   - { ok: true, message } si el servicio respondió 200.
 *   - { ok: false, reason: 'UNREACHABLE', err } si no hay servicio.
 *   - { ok: false, reason: 'HTTP_ERROR', status, err } si respondió no-2xx.
 */
async function serviceLogout(serviceUrl, idEmpresa) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        return { ok: false, reason: 'NO_JWT_SECRET' };
    }
    const token = jwt.sign(
        { sub: 'reset-test-data', scope: 'internal' },
        secret,
        { expiresIn: '60s' }
    );
    const url = `${serviceUrl.replace(/\/$/, '')}/disconnect/${idEmpresa}`;
    try {
        const res = await axios.delete(url, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 20000, // logout de Baileys puede demorar por el IQ a WhatsApp
            validateStatus: () => true,
        });
        if (res.status >= 200 && res.status < 300) {
            return { ok: true, message: res.data?.message || 'OK' };
        }
        return {
            ok: false,
            reason: 'HTTP_ERROR',
            status: res.status,
            body: res.data,
        };
    } catch (err) {
        const reason = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET'
            ? 'UNREACHABLE'
            : 'NETWORK_ERROR';
        return { ok: false, reason, err };
    }
}

async function tableCount(pool, table) {
    try {
        const [rows] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
        return rows[0].n;
    } catch (e) {
        if (e.code === 'ER_NO_SUCH_TABLE') return null;
        throw e;
    }
}

async function confirm(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`${message} [y/N] `, (ans) => {
            rl.close();
            resolve(/^y(es)?$/i.test(ans.trim()));
        });
    });
}

function resolveMediaDir(idEmpresa) {
    const storageRoot = process.env.MEDIA_STORAGE_ROOT
        || path.join(__dirname, '..', 'storage');
    return path.join(storageRoot, 'media', String(idEmpresa));
}

function dirSize(dir) {
    let total = 0;
    let files = 0;
    if (!fs.existsSync(dir)) return { files, total };
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
            const p = path.join(cur, entry.name);
            if (entry.isDirectory()) stack.push(p);
            else {
                try {
                    total += fs.statSync(p).size;
                    files += 1;
                } catch (_) { /* ignore */ }
            }
        }
    }
    return { files, total };
}

function humanBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function main() {
    const opts = parseArgs(process.argv);
    const {
        idEmpresa, dryRun, yes,
        withSession, withVendors, withMedia,
        skipLogout, serviceUrl,
    } = opts;

    console.log(`\n=== reset-test-data (empresa ${idEmpresa}) ===`);
    console.log(`Modo:      ${dryRun ? 'DRY-RUN (solo lectura)' : 'BORRADO REAL'}`);
    if (withSession) {
        console.log(
            `Sesión:    SE BORRA — ${skipLogout
                ? 'SOLO DB (móvil quedará con dispositivo vinculado)'
                : `desvincula dispositivo vía ${serviceUrl}/disconnect/${idEmpresa}`}`
        );
    } else {
        console.log('Sesión:    se conserva');
    }
    console.log(`Vendedores:${withVendors ? ' SE VACÍA wa_vendor_state' : ' se conserva'}`);
    console.log(`Media:     ${withMedia ? 'SE BORRA del disco' : 'se conserva'}`);
    console.log('');

    const pool = await tenantResolver.getPool(idEmpresa);

    // 1) Snapshot de cuentas actuales
    console.log('Estado actual:');
    const targets = [...CORE_TABLES];
    if (withVendors) targets.push('wa_vendor_state');
    if (withSession) targets.push('wa_session_auth');

    const counts = {};
    for (const t of targets) {
        const n = await tableCount(pool, t);
        counts[t] = n;
        console.log(`  - ${t.padEnd(22)} ${n === null ? '(tabla no existe)' : `${n} filas`}`);
    }

    let mediaStats = null;
    if (withMedia) {
        const mediaDir = resolveMediaDir(idEmpresa);
        mediaStats = { dir: mediaDir, ...dirSize(mediaDir) };
        console.log(`  - media/${idEmpresa}         ${mediaStats.files} archivos (${humanBytes(mediaStats.total)})`);
    }
    console.log('');

    if (dryRun) {
        console.log('[dry-run] No se borra nada. Salir.');
        await tenantResolver.refresh(idEmpresa);
        return;
    }

    // 2) Confirmación
    if (!yes) {
        const ok = await confirm(`¿Confirmás borrar los datos anteriores de la empresa ${idEmpresa}?`);
        if (!ok) {
            console.log('Cancelado.');
            await tenantResolver.refresh(idEmpresa);
            return;
        }
    }

    // 3) Logout vía servicio (solo si --with-session y no --skip-logout).
    //    Esto es lo que hace que WhatsApp remueva el dispositivo del móvil.
    //    TIENE QUE IR ANTES de los TRUNCATE: si primero vaciamos
    //    wa_session_auth, el socket del servicio pierde las credenciales y
    //    logout() falla, dejando el móvil vinculado.
    if (withSession && !skipLogout) {
        console.log(`→ Llamando DELETE ${serviceUrl}/disconnect/${idEmpresa} ...`);
        const r = await serviceLogout(serviceUrl, idEmpresa);
        if (r.ok) {
            console.log(`  ✅ Dispositivo desvinculado en WhatsApp (${r.message})`);
        } else if (r.reason === 'UNREACHABLE') {
            console.error(`  ❌ Servicio inalcanzable en ${serviceUrl}.`);
            console.error('     Arrancalo (pm2 start ntmsg-app) y reintentá, o pasá --skip-logout');
            console.error('     si asumís dejar el dispositivo vinculado en el móvil.');
            await tenantResolver.refresh(idEmpresa);
            process.exit(3);
        } else if (r.reason === 'NO_JWT_SECRET') {
            console.error('  ❌ JWT_SECRET no está en el entorno (.env) — no puedo autenticar.');
            await tenantResolver.refresh(idEmpresa);
            process.exit(4);
        } else {
            console.error(`  ❌ Logout HTTP falló (${r.reason}${r.status ? ' ' + r.status : ''}):`);
            console.error(`     ${r.err?.message || JSON.stringify(r.body)}`);
            console.error('     Abortando para no dejar el móvil vinculado sin querer.');
            console.error('     Usá --skip-logout si entendés las consecuencias.');
            await tenantResolver.refresh(idEmpresa);
            process.exit(5);
        }
    } else if (withSession && skipLogout) {
        console.log('⚠  --skip-logout activo: el móvil seguirá mostrando el dispositivo vinculado.');
    }

    // 4) Borrado
    const conn = await pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const t of CORE_TABLES) {
            if (counts[t] === null) continue; // tabla no existe
            await conn.query(`TRUNCATE TABLE \`${t}\``);
            console.log(`  ✅ TRUNCATE ${t}`);
        }
        if (withVendors && counts['wa_vendor_state'] !== null) {
            await conn.query('TRUNCATE TABLE `wa_vendor_state`');
            console.log('  ✅ TRUNCATE wa_vendor_state');
        }
        if (withSession) {
            if (counts['wa_session_auth'] !== null) {
                await conn.query('TRUNCATE TABLE `wa_session_auth`');
                console.log('  ✅ TRUNCATE wa_session_auth');
            }
            await conn.query(`
                UPDATE \`wa_session_state\`
                   SET status = 'NOT_REGISTERED',
                       phone_number = NULL,
                       pushname = NULL,
                       last_error = NULL,
                       qr_attempts = 0,
                       paused_until = NULL,
                       last_seen_at = NULL
                 WHERE id = 1
            `);
            console.log('  ✅ wa_session_state → NOT_REGISTERED');
        }
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally {
        conn.release();
    }

    // 5) Media
    if (withMedia && mediaStats && fs.existsSync(mediaStats.dir)) {
        fs.rmSync(mediaStats.dir, { recursive: true, force: true });
        console.log(`  ✅ rm -rf ${mediaStats.dir} (${mediaStats.files} archivos, ${humanBytes(mediaStats.total)})`);
    }

    console.log('\n⚠️  Reiniciá msg_ninesys para limpiar cachés en memoria:');
    console.log('     pm2 restart msg_ninesys   (o equivalente)');
    console.log('');

    await tenantResolver.refresh(idEmpresa);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n[reset-test-data] ERROR:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    });

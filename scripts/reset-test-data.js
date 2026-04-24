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
 *   --dry-run       Muestra cuentas actuales sin borrar nada.
 *   --yes           Omite la confirmación interactiva.
 *   --with-session  TRUNCATE wa_session_auth y resetea wa_session_state
 *                   a NOT_REGISTERED (la próxima vez pedirá QR).
 *   --with-vendors  Vacía wa_vendor_state (disponibilidad de vendedores).
 *   --with-media    Borra <STORAGE_ROOT>/media/<idEmpresa>/ del disco.
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
    };
    for (const a of argv.slice(2)) {
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--yes' || a === '-y') out.yes = true;
        else if (a === '--with-session') out.withSession = true;
        else if (a === '--with-vendors') out.withVendors = true;
        else if (a === '--with-media') out.withMedia = true;
        else if (/^\d+$/.test(a)) out.idEmpresa = parseInt(a, 10);
        else {
            console.error(`[reset-test-data] argumento desconocido: ${a}`);
            process.exit(2);
        }
    }
    return out;
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
    const { idEmpresa, dryRun, yes, withSession, withVendors, withMedia } = opts;

    console.log(`\n=== reset-test-data (empresa ${idEmpresa}) ===`);
    console.log(`Modo:      ${dryRun ? 'DRY-RUN (solo lectura)' : 'BORRADO REAL'}`);
    console.log(`Sesión:    ${withSession ? 'SE BORRA (pedirá QR)' : 'se conserva'}`);
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

    // 3) Borrado
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

    // 4) Media
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

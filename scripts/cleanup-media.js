#!/usr/bin/env node
/**
 * cleanup-media.js
 *
 * Borra archivos de storage/media con mtime anterior al umbral de retención
 * (default 60 días, configurable por MEDIA_RETENTION_DAYS).
 *
 * Uso:
 *   node scripts/cleanup-media.js [--days=N] [--dry-run]
 *
 * Integración sugerida (cron del sistema):
 *   0 3 * * *  cd /opt/msg_ninesys && /usr/bin/node scripts/cleanup-media.js
 *
 * O con PM2 (cron via pm2):
 *   pm2 start scripts/cleanup-media.js --name media-cleanup --cron "0 3 * * *" --no-autorestart
 */

require('dotenv').config();
const mediaStore = require('../src/services/mediaStore');

function parseArgs(argv) {
    const out = { days: null, dryRun: false };
    for (const a of argv.slice(2)) {
        if (a === '--dry-run') out.dryRun = true;
        else if (a.startsWith('--days=')) out.days = Number(a.slice(7));
    }
    return out;
}

function humanBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function main() {
    const { days: argDays, dryRun } = parseArgs(process.argv);
    const days = argDays || mediaStore.RETENTION_DAYS;

    console.log(`[cleanup-media] retención=${days} días dry-run=${dryRun}`);
    console.log(`[cleanup-media] root=${mediaStore.MEDIA_ROOT}`);

    if (dryRun) {
        console.log('[cleanup-media] dry-run: no se ha implementado listado previo, ejecutar sin --dry-run.');
        process.exit(0);
    }

    const started = Date.now();
    const stats = mediaStore.cleanupOlderThan(days);
    const durMs = Date.now() - started;
    console.log(
        `[cleanup-media] completado en ${durMs}ms  scanned=${stats.scanned}  deleted=${stats.deleted}  freed=${humanBytes(stats.bytes)}  errors=${stats.errors}`
    );
    process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('[cleanup-media] error fatal:', e);
    process.exit(2);
});

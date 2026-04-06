#!/usr/bin/env node
/**
 * Smoke test del tenantResolver.
 *
 * Uso:
 *   node scripts/test-tenant-resolver.js [id_empresa]
 *
 * Por defecto prueba con la empresa 163.
 *
 * IMPORTANTE: como db_host de las empresas suele ser `localhost` (en el VPS
 * dev), este script DEBE correrse desde el VPS donde vive MySQL, o detrás de
 * un túnel SSH:
 *
 *   ssh -L 3306:localhost:3306 vps-ninesys
 *
 * y dejar el túnel abierto en otra terminal mientras se ejecuta este script.
 */

require('dotenv').config();
const tenantResolver = require('../src/db/tenantResolver');
const credentialsClient = require('../src/db/credentialsClient');

const id = parseInt(process.argv[2] || '163', 10);

(async () => {
    console.log(`\n=== test-tenant-resolver (empresa ${id}) ===\n`);

    try {
        console.log('1) ping a ninesys-api...');
        await credentialsClient.ping();
        console.log('   ✅ ping OK');

        console.log(`2) fetchCredentials(${id})...`);
        const creds = await tenantResolver.getCredentials(id);
        console.log('   ✅ credenciales recibidas:');
        console.log(`      nombre:  ${creds.nombre}`);
        console.log(`      host:    ${creds.db_host}`);
        console.log(`      user:    ${creds.db_user}`);
        console.log(`      db:      ${creds.db_name}`);
        console.log(`      pass:    ${creds.db_password ? '[REDACTED ' + creds.db_password.length + ' chars]' : '(vacío)'}`);

        console.log(`3) getPool(${id}) + SELECT 1...`);
        const pool = await tenantResolver.getPool(id);
        const [rows] = await pool.query('SELECT 1 AS ok');
        console.log(`   ✅ SELECT 1 → ${JSON.stringify(rows[0])}`);

        console.log(`4) Probar tablas de negocio (customers, ordenes, products)...`);
        for (const table of ['customers', 'ordenes', 'products', 'ordenes_productos']) {
            try {
                const [r] = await pool.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
                console.log(`   ✅ ${table}: ${r[0].n} filas`);
            } catch (e) {
                console.log(`   ⚠️  ${table}: ${e.message}`);
            }
        }

        console.log(`5) Cache hit (segunda llamada a getCredentials)...`);
        const t0 = Date.now();
        await tenantResolver.getCredentials(id);
        console.log(`   ✅ resuelto en ${Date.now() - t0}ms (debería ser <5ms)`);

        console.log(`6) refresh(${id})...`);
        await tenantResolver.refresh(id);
        console.log(`   ✅ pool cerrado y cache invalidado`);

        console.log('\n=== TODO OK ===\n');
        process.exit(0);
    } catch (err) {
        console.error('\n❌ FALLÓ:', err.message);
        if (err.status) console.error('   status:', err.status);
        if (err.body) console.error('   body:', err.body);
        if (err.code) console.error('   code:', err.code);
        process.exit(1);
    }
})();

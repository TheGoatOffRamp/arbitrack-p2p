'use strict';
// Copia los datos de la versión local (carpeta data/: ledger.json y credenciales cifradas)
// a la cuenta de un usuario en PostgreSQL.
//
//   DATABASE_URL=... ARBITRACK_SECRET=... node scripts/importar-datos-locales.js --email tu@correo.com [--data ./data] [--reemplazar]
//
// La clave de las credenciales locales es data/.key; si en la versión local usabas ARBITRACK_SECRET,
// pásala como ARBITRACK_LOCAL_SECRET.
const path = require('path');
const { Store } = require('../src/store');
const { Secrets, deriveKey } = require('../src/secrets');
const { createPool, migrate, PgLedger, PgSecrets } = require('../src/db');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const dataDir = path.resolve(arg('data') || path.join(__dirname, '..', 'data'));
  const replace = process.argv.includes('--reemplazar');
  if (!email) throw new Error('Indique --email de la cuenta destino (debe estar registrada en la web).');
  if (!process.env.DATABASE_URL || !process.env.ARBITRACK_SECRET) throw new Error('Defina DATABASE_URL y ARBITRACK_SECRET (los mismos del servidor).');

  const pool = createPool();
  try {
    await migrate(pool);
    const { rows } = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (!rows[0]) throw new Error(`No existe la cuenta ${email}. Regístrate primero en la web.`);
    const userId = rows[0].id;

    const ledger = await new PgLedger(pool, userId).load();
    const current = ledger.read();
    if (current.trades.length && !replace) {
      throw new Error(`La cuenta ya tiene ${current.trades.length} operaciones. Use --reemplazar para sobrescribirlas.`);
    }
    const state = new Store(dataDir).load();
    await ledger.replace(state);

    const local = new Secrets(dataDir, { secret: process.env.ARBITRACK_LOCAL_SECRET || null }).all();
    const remote = new PgSecrets(pool, userId, deriveKey(process.env.ARBITRACK_SECRET));
    for (const [exchange, cred] of Object.entries(local)) await remote.set(exchange, cred);

    console.log(`Listo: ${state.trades.filter((t) => !t.deleted).length} operaciones, ${state.costs.length} costos, `
      + `${state.cycles.length} ciclos y ${Object.keys(local).length} credenciales copiadas a ${email}.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });

'use strict';
// Modo multiusuario: PostgreSQL. Cada usuario tiene su propio libro (mismo formato que ledger.json)
// y sus propias credenciales de exchanges, cifradas y ligadas a su id.
const { Pool } = require('pg');
const { emptyState, SCHEMA_VERSION } = require('./store');
const { encryptBox, decryptBox } = require('./secrets');

const MIGRATIONS = [
  `CREATE TABLE users (
     id uuid PRIMARY KEY,
     email text NOT NULL,
     name text,
     password_hash text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE UNIQUE INDEX users_email_key ON users (lower(email));
   CREATE TABLE sessions (
     id text PRIMARY KEY,                 -- sha256 del token; el token en claro solo vive en la cookie
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     ip text,
     user_agent text
   );
   CREATE INDEX sessions_user_idx ON sessions (user_id);
   CREATE TABLE password_resets (
     id text PRIMARY KEY,                 -- sha256 del token enviado por email
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(),
     expires_at timestamptz NOT NULL,
     used_at timestamptz
   );
   CREATE TABLE ledgers (
     user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     state jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE exchange_credentials (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     exchange text NOT NULL,
     box jsonb NOT NULL,
     connected_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, exchange)
   );`,
];

function createPool(connectionString = process.env.DATABASE_URL) {
  const ssl = /sslmode=(require|verify)/.test(connectionString) || process.env.PGSSL === 'true' ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false' } : undefined;
  return new Pool({ connectionString, ssl, max: Number(process.env.PGPOOL_MAX || 10) });
}

/** Aplica las migraciones pendientes (idempotente; seguro con varias instancias gracias al lock). */
async function migrate(pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(424242)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await c.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const v = i + 1;
      if (done.has(v)) continue;
      await c.query('BEGIN');
      try {
        await c.query(MIGRATIONS[i]);
        await c.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    c.release();
  }
}

async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { c.release(); }
}

/**
 * Libro de un usuario con la misma interfaz que Store: read() síncrono sobre una instantánea cargada
 * al inicio de la petición, y mutate(fn) todo o nada con bloqueo de fila (sirve con varias instancias).
 */
class PgLedger {
  constructor(pool, userId) {
    this.pool = pool;
    this.userId = userId;
    this.state = null;
  }

  async load() {
    const { rows } = await this.pool.query('SELECT state FROM ledgers WHERE user_id = $1', [this.userId]);
    this.state = rows[0] ? rows[0].state : emptyState();
    return this;
  }

  read() {
    if (!this.state) throw new Error('PgLedger.read() antes de load()');
    return this.state;
  }

  async mutate(fn) {
    return tx(this.pool, async (c) => {
      await c.query('INSERT INTO ledgers (user_id, state) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [this.userId, emptyState()]);
      const { rows } = await c.query('SELECT state FROM ledgers WHERE user_id = $1 FOR UPDATE', [this.userId]);
      const draft = rows[0].state;
      if (draft.schemaVersion !== SCHEMA_VERSION) throw new Error(`Versión de esquema desconocida: ${draft.schemaVersion}`);
      const result = await fn(draft);
      await c.query('UPDATE ledgers SET state = $2, updated_at = now() WHERE user_id = $1', [this.userId, draft]);
      this.state = draft;
      return result;
    });
  }

  /** Reemplaza el libro completo (migración desde la versión local). */
  async replace(state) {
    await this.pool.query(
      `INSERT INTO ledgers (user_id, state) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [this.userId, state]);
    this.state = state;
  }
}

/** Credenciales de un usuario. Misma interfaz que Secrets, pero asíncrona. */
class PgSecrets {
  constructor(pool, userId, key) {
    this.pool = pool;
    this.userId = userId;
    this.key = key;
    this.keySource = 'env';
  }

  async all() {
    const { rows } = await this.pool.query('SELECT exchange, box FROM exchange_credentials WHERE user_id = $1 ORDER BY exchange', [this.userId]);
    const out = {};
    for (const r of rows) {
      try { out[r.exchange] = decryptBox(this.key, r.box, this.userId); } catch {
        throw new Error('No se pudieron descifrar las credenciales (¿cambió ARBITRACK_SECRET?). Vuelva a conectar los exchanges.');
      }
    }
    return out;
  }

  async get(name) { return (await this.all())[name] || null; }

  async set(name, cred) {
    await this.pool.query(
      `INSERT INTO exchange_credentials (user_id, exchange, box) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, exchange) DO UPDATE SET box = EXCLUDED.box, connected_at = now()`,
      [this.userId, name, encryptBox(this.key, cred, this.userId)]);
  }

  async remove(name) {
    await this.pool.query('DELETE FROM exchange_credentials WHERE user_id = $1 AND exchange = $2', [this.userId, name]);
  }
}

module.exports = { createPool, migrate, tx, PgLedger, PgSecrets, MIGRATIONS };

'use strict';
// Almacenamiento JSON con escritura atómica, copia de respaldo y mutaciones serializadas (todo o nada).
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 2;

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, trades: [], cycles: [], costs: [], batches: [], quarantine: [], audit: [] };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'ledger.json');
    fs.mkdirSync(dir, { recursive: true });
    this.queue = Promise.resolve();
    this.state = null;
  }

  load() {
    if (this.state) return this.state;
    if (fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      try {
        this.state = JSON.parse(raw);
      } catch (e) {
        throw new Error(`ledger.json está corrupto (${e.message}). Restaure ledger.json.bak manualmente; no se sobrescribió nada.`);
      }
      if (this.state.schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`Versión de esquema desconocida: ${this.state.schemaVersion}`);
      }
    } else {
      this.state = emptyState();
      const legacy = path.join(this.dir, 'trades.json');
      if (fs.existsSync(legacy)) {
        const { migrateLegacy } = require('./migrate');
        const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        migrateLegacy(this.state, Array.isArray(old) ? old : []);
        fs.copyFileSync(legacy, path.join(this.dir, `trades.legacy-${Date.now()}.json`));
      }
      this.persist(this.state);
    }
    return this.state;
  }

  persist(state) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(tmp, this.file);
  }

  /** Lectura (no bloquea). */
  read() { return this.load(); }

  /**
   * Aplica `fn(draft)` sobre una copia; si lanza excepción no se guarda NADA.
   * Las mutaciones se ejecutan una a la vez (evita condiciones de carrera entre peticiones).
   */
  mutate(fn) {
    const run = async () => {
      const current = this.load();
      const draft = structuredClone(current);
      const result = await fn(draft);
      this.persist(draft);
      this.state = draft;
      return result;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { Store, SCHEMA_VERSION, emptyState };

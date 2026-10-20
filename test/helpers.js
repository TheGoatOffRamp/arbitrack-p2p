'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/app');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'arbitrack-test-')); }

async function startApp(opts = {}) {
  process.env.NODE_ENV = 'test';
  const dataDir = opts.dataDir || tmpDir();
  const app = createApp({ dataDir, publicDir: dataDir, ...opts });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data };
  };
  return { app, server, base, dataDir, call, close: () => new Promise((r) => server.close(r)) };
}

/** Operación en formato de estado (para pruebas del motor). */
let seq = 0;
function T(o) {
  const { buildTrade } = require('../src/model');
  const r = buildTrade({ exchange: 'Binance', orderId: `o${++seq}`, status: 'completado', crypto: 'USDT', fiat: 'PEN', ...o }, { source: 'manual' });
  if (r.rejected) throw new Error(r.rejected.reasons.join('; '));
  return { ...r.trade, history: [], manualFields: [], batchIds: ['t'], deleted: false };
}

module.exports = { tmpDir, startApp, T };

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

test('reporte PDF para el contador', async () => {
  const ctx = await startApp();
  try {
    const t = (o) => ctx.call('POST', '/api/v1/trades', { date: '2026-09-01 10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: '100', price: '3.70', status: 'completado', ...o });
    await t({ type: 'compra', orderId: 'p1' });
    await t({ type: 'venta', orderId: 'p2', price: '3.75', date: '2026-09-02 10:00' });
    const r = await ctx.call('GET', '/api/v1/export/pdf?from=2026-09-01&to=2026-09-30&userName=Prueba');
    assert.equal(r.status, 200);
    assert.equal(r.data.slice(0, 5).toString(), '%PDF-');
    assert.ok(r.data.length > 2000);
    const empty = await ctx.call('GET', '/api/v1/export/pdf?from=2020-01-01&to=2020-01-31');
    assert.equal(empty.status, 200, 'un período sin operaciones también genera el reporte');
  } finally { await ctx.close(); }
});

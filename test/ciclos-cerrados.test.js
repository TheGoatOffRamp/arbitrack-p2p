'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

let n = 0;
const op = (side, amount, price, dateUtc, extra = {}) => ({
  side, exchange: 'Binance', orderId: `cc${++n}`, crypto: 'USDT', fiat: 'PEN', amount: String(amount), price: String(price),
  total: (amount * price).toFixed(2), fee: '0', status: 'completado', dateUtc, ...extra,
});
const net = (rep, pair = 'USDT/PEN') => Number(rep.pairs.find((p) => p.pair === pair)?.net || 0);

async function setup(t) {
  const h = await startApp();
  t.after(h.close);
  for (const o of [
    op('buy', 1000, 3.70, '2026-10-01T15:00:00Z'),
    op('sell', 800, 3.75, '2026-10-02T15:00:00Z'),
    op('buy', 500, 3.72, '2026-10-05T15:00:00Z'),
    op('sell', 700, 3.76, '2026-10-06T15:00:00Z'),
  ]) assert.equal((await h.call('POST', '/api/v1/trades', o)).status, 200);
  return h;
}

test('cerrar un ciclo congela su resultado y el ciclo actual sigue con el sobrante a su costo', async (t) => {
  const { call } = await setup(t);
  const pv = await call('GET', '/api/v1/closings/preview?pair=USDT/PEN&cutoff=2026-10-03T00:00');
  assert.equal(pv.status, 200);
  assert.equal(pv.data.trades, 2);
  assert.equal(Number(pv.data.summary.net), 40);
  assert.equal(Number(pv.data.carriedQty), 200);
  // La vista previa no guarda nada.
  assert.equal((await call('GET', '/api/v1/closings')).data.closings.length, 0);

  const cl = await call('POST', '/api/v1/closings', { pair: 'usdt/pen', cutoff: '2026-10-03T00:00' });
  assert.equal(cl.status, 201);
  const k = cl.data.closing;
  assert.equal(k.seq, 1);
  assert.equal(k.name, 'USDT/PEN · Ciclo #1');
  assert.equal(k.intact, true);
  assert.equal(k.carryLots, undefined);

  const closed = (await call('GET', `/api/v1/report?scope=${k.id}`)).data;
  const actual = (await call('GET', '/api/v1/report?scope=actual')).data;
  const todo = (await call('GET', '/api/v1/report')).data;
  assert.equal(net(closed), 40);
  // 200 sobrantes a 3.70 + 500 a 3.72, vendidos a 3.76
  assert.equal(net(actual), 32);
  assert.equal(actual.pairs[0].sells.count, 1);
  // Con el sobrante a su costo el FIFO no se rompe: cerrado + actual = historial completo.
  assert.equal(net(todo), 72);
});

test('lo cerrado no se puede editar ni borrar, y una sincronización no lo cambia', async (t) => {
  const { call } = await setup(t);
  const { closing } = (await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00' })).data;
  const trades = (await call('GET', '/api/v1/trades')).data.trades;
  const frozen = trades.find((x) => x.closingId === closing.id);
  assert.ok(frozen);
  assert.equal((await call('PUT', `/api/v1/trades/${frozen.id}`, { price: '3.80' })).status, 409);
  assert.equal((await call('DELETE', `/api/v1/trades/${frozen.id}`)).status, 409);

  // Reimportar la misma orden con otro estado no la modifica: queda como conflicto informado.
  const again = { ...op('buy', 1000, 3.70, '2026-10-01T15:00:00Z'), orderId: frozen.orderId, status: 'cancelado' };
  const imp = await call('POST', '/api/v1/import', { trades: [again] });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.imported, 0);
  const after = (await call('GET', '/api/v1/trades')).data.trades.find((x) => x.id === frozen.id);
  assert.equal(after.status, 'completado');
  const list = (await call('GET', '/api/v1/closings')).data.closings;
  assert.equal(list[0].intact, true);
});

test('una operación tardía anterior al corte va al ciclo actual con aviso y no toca el cerrado', async (t) => {
  const { call } = await setup(t);
  const { closing } = (await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00' })).data;
  await call('POST', '/api/v1/trades', op('buy', 100, 3.60, '2026-10-02T10:00:00Z'));
  const closed = (await call('GET', `/api/v1/report?scope=${closing.id}`)).data;
  assert.equal(net(closed), 40);
  const actual = (await call('GET', '/api/v1/report?scope=actual')).data;
  assert.ok(actual.issues.some((i) => i.code === 'ANTERIOR_AL_CIERRE'));
  assert.equal((await call('GET', '/api/v1/closings')).data.closings[0].intact, true);
});

test('cierres encadenados: el corte debe avanzar y solo se reabre el último', async (t) => {
  const { call } = await setup(t);
  const c1 = (await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00' })).data.closing;
  assert.equal((await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-02T00:00' })).status, 400);
  const c2 = (await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-07T00:00', name: 'Octubre' })).data.closing;
  assert.equal(c2.seq, 2);
  assert.equal(c2.name, 'Octubre');
  assert.equal(net((await call('GET', `/api/v1/report?scope=${c2.id}`)).data), 32);
  // Sin nada nuevo, el ciclo actual queda vacío.
  assert.equal(net((await call('GET', '/api/v1/report?scope=actual')).data), 0);
  // Futuro o sin operaciones: rechazado.
  assert.equal((await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2099-01-01T00:00' })).status, 400);
  assert.equal((await call('POST', '/api/v1/closings', { pair: 'USDT/USD', cutoff: '2026-10-08T00:00' })).status, 400);

  assert.equal((await call('DELETE', `/api/v1/closings/${c1.id}`)).status, 409);
  assert.equal((await call('DELETE', `/api/v1/closings/${c2.id}`)).data.reopened, 2);
  assert.equal((await call('DELETE', `/api/v1/closings/${c1.id}`)).data.reopened, 2);
  const actual = (await call('GET', '/api/v1/report?scope=actual')).data;
  assert.equal(net(actual), 72);
  assert.ok((await call('GET', '/api/v1/trades')).data.trades.every((x) => !x.closingId));
});

test('sin arrastre, el ciclo nuevo empieza de cero y la venta sin compra se marca', async (t) => {
  const { call } = await setup(t);
  await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00', carry: false });
  const actual = (await call('GET', '/api/v1/report?scope=actual')).data;
  assert.equal(net(actual), 20);
  assert.ok(actual.issues.some((i) => i.code === 'VENTA_SIN_COMPRA'));
});

test('un ciclo manual no puede quedar partido por el corte', async (t) => {
  const { call } = await setup(t);
  const ids = (await call('GET', '/api/v1/trades')).data.trades.map((x) => x.id);
  assert.equal((await call('POST', '/api/v1/cycles', { name: 'Mi ciclo', pair: 'USDT/PEN', tradeIds: ids })).status, 200);
  const r = await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Mi ciclo/);
});

test('exportar un ciclo cerrado: Excel y PDF con su propio nombre de archivo', async (t) => {
  const { base, call } = await setup(t);
  const { closing } = (await call('POST', '/api/v1/closings', { pair: 'USDT/PEN', cutoff: '2026-10-03T00:00' })).data;
  for (const kind of ['excel', 'pdf']) {
    const res = await fetch(`${base}/api/v1/export/${kind}?scope=${closing.id}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /USDT-PEN_ciclo-1/);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  }
  assert.equal((await call('GET', '/api/v1/report?scope=K-NOEXISTE')).status, 400);
});

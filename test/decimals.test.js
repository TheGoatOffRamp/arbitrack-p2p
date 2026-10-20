'use strict';
// Regresión: los números de la API, del formulario y del almacenamiento interno siempre usan punto decimal.
// "3.411" nunca debe tratarse como ambiguo (¿3411?) en esos caminos; solo en archivos importados.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

const resp = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });

test('sync Binance con precios de 3 decimales (caso real: 237 órdenes rechazadas)', async () => {
  const S = Date.parse('2026-09-05T15:00:00Z');
  const orders = [
    { orderNumber: '22937006439541825536', tradeType: 'BUY', asset: 'USDT', fiat: 'PEN', amount: '293.18000000', totalPrice: '1000.00', unitPrice: '3.411', orderStatus: 'COMPLETED', createTime: S, commission: '0.00000000', counterPartNickName: 'a' },
    { orderNumber: '22936477090934591488', tradeType: 'SELL', asset: 'USDT', fiat: 'PEN', amount: '100.00000000', totalPrice: '338.70', unitPrice: '3.387', orderStatus: 'COMPLETED', createTime: S + 60000, commission: '0.05000000', counterPartNickName: 'b' },
    { orderNumber: '22935866103328305152', tradeType: 'SELL', asset: 'USDT', fiat: 'PEN', amount: '1.000', totalPrice: '3.372', unitPrice: '3.372', orderStatus: 'CANCELLED', createTime: S + 120000, commission: '0', counterPartNickName: 'c' },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('/api/v3/time')) return resp(200, { serverTime: Date.now() });
    const u = new URL(url);
    const list = orders.filter((o) => o.tradeType === u.searchParams.get('tradeType') && o.createTime >= +u.searchParams.get('startTimestamp') && o.createTime <= +u.searchParams.get('endTimestamp'));
    return resp(200, { code: '000000', success: true, total: list.length, data: u.searchParams.get('page') === '1' ? list : [] });
  };
  const h = await startApp({ fetchImpl, sleepImpl: async () => {} });
  try {
    await h.call('POST', '/api/v1/exchange/connect', { exchange: 'Binance', apiKey: 'K', apiSecret: 'S' });
    const r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-29' });
    assert.equal(r.status, 200, r.data.error + ' ' + JSON.stringify(r.data.problems));
    assert.equal(r.data.newImported, 3);
    const t = (await h.call('GET', '/api/v1/trades')).data.trades;
    const buy = t.find((x) => x.orderId === '22937006439541825536');
    assert.equal(buy.exact.price, '3.411');
    assert.equal(buy.exact.amount, '293.18');
    assert.equal(t.find((x) => x.orderId === '22936477090934591488').exact.fee, '0.05');
    assert.equal(t.find((x) => x.orderId === '22935866103328305152').status, 'cancelado');
    // editar una operación de la API con precio de 3 decimales (antes fallaba por "separador ambiguo")
    const e = await h.call('PUT', `/api/v1/trades/${buy.id}`, { notes: 'revisado' });
    assert.equal(e.status, 200, e.data.error);
    assert.equal(e.data.trade.exact.price, '3.411');
  } finally { await h.close(); }
});

test('formulario manual y registro rápido con precio 3.365 y montos 1.500', async () => {
  const h = await startApp();
  try {
    let r = await h.call('POST', '/api/v1/trades', { type: 'venta', date: '2026-09-10T10:00', exchange: 'OKX', crypto: 'USDT', fiat: 'PEN', amount: '1.500', price: '3.365', status: 'completado', fee: '0', feeType: 'crypto' });
    assert.equal(r.status, 200, r.data.error);
    assert.equal(r.data.trade.exact.amount, '1.5', 'en el formulario "1.500" es 1,5 (punto decimal), nunca 1500');
    assert.equal(r.data.trade.exact.total, '5.0475');
    r = await h.call('PUT', `/api/v1/trades/${r.data.trade.id}`, { price: '3.366' });
    assert.equal(r.status, 200, r.data.error);
    assert.equal(r.data.trade.exact.price, '3.366');
    // importación heredada desde la webapp (números JS)
    r = await h.call('POST', '/api/v1/import', { trades: [{ type: 'compra', date: '2026-09-10T09:00', exchange: 'Bybit', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.341, total: 334.1, status: 'completado' }] });
    assert.equal(r.data.imported, 1, JSON.stringify(r.data.rejected));
  } finally { await h.close(); }
});

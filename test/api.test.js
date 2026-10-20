'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { ADAPTERS } = require('../src/exchanges/adapters');
const { requestJson } = require('../src/exchanges/http');
const { startApp } = require('./helpers');

const resp = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const noSleep = async () => {};
const S = Date.parse('2026-09-01T05:00:00Z'), E = Date.parse('2026-09-10T05:00:00Z');

function binanceOrder(n, type, status = 'COMPLETED', extra = {}) {
  return { orderNumber: `2281000000000000${String(n).padStart(4, '0')}`, advNo: 'a', tradeType: type, asset: 'USDT', fiat: 'PEN',
    amount: '100.00000000', totalPrice: type === 'BUY' ? '370.00' : '376.00', unitPrice: type === 'BUY' ? '3.70' : '3.76',
    orderStatus: status, createTime: S + n * 60000, commission: type === 'BUY' ? '0.1' : '0', counterPartNickName: `cp${n}`, payMethodName: 'BCP', ...extra };
}

test('Binance: firma, paginación completa (BUY y SELL) y estados reales', async () => {
  const calls = [];
  const buys = Array.from({ length: 55 }, (_, i) => binanceOrder(i, 'BUY'));
  const sells = [binanceOrder(100, 'SELL'), binanceOrder(101, 'SELL', 'CANCELLED_BY_SYSTEM'), binanceOrder(102, 'SELL', 'IN_APPEAL')];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (url.includes('/api/v3/time')) return resp(200, { serverTime: Date.now() });
    const u = new URL(url);
    const sig = u.searchParams.get('signature');
    u.searchParams.delete('signature');
    assert.equal(sig, crypto.createHmac('sha256', 'SECRET').update(u.searchParams.toString()).digest('hex'));
    assert.equal(init.headers['X-MBX-APIKEY'], 'KEY');
    const page = Number(u.searchParams.get('page')), rows = Number(u.searchParams.get('rows'));
    const src = u.searchParams.get('tradeType') === 'BUY' ? buys : sells;
    return resp(200, { code: '000000', success: true, total: src.length, data: src.slice((page - 1) * rows, page * rows) });
  };
  const r = await ADAPTERS.binance({ apiKey: 'KEY', apiSecret: 'SECRET' }, S, E, { fetchImpl, sleepImpl: noSleep });
  assert.equal(r.candidates.length, 58, 'la versión anterior solo leía hasta que una página tuviera < 20');
  assert.equal(r.schemaErrors.length, 0);
  assert.equal(r.candidates.find((c) => c.orderId.endsWith('0101')).status, 'cancelado', 'CANCELLED_BY_SYSTEM ya no se registra como pendiente');
  assert.equal(r.candidates.find((c) => c.orderId.endsWith('0102')).status, 'en_disputa');
  assert.equal(r.candidates[0].feeAsset, 'USDT');
});

test('Bybit: POST firmado, side 0 = compra / 1 = venta, cantidad cripto y estados', async () => {
  const items = [
    { id: '1', side: 0, tokenId: 'USDT', amount: '370', currencyId: 'PEN', price: '3.7', notifyTokenQuantity: '100', fee: '0', targetNickName: 'a', status: 50, createDate: String(S + 1000) },
    { id: '2', side: 1, tokenId: 'USDT', amount: '376', currencyId: 'PEN', price: '3.76', notifyTokenQuantity: '100', fee: '0.05', targetNickName: 'b', status: 50, createDate: String(S + 2000) },
    { id: '3', side: 1, tokenId: 'USDT', amount: '37.6', currencyId: 'PEN', price: '3.76', notifyTokenQuantity: '10', fee: '0', targetNickName: 'c', status: 40, createDate: String(S + 3000) },
    { id: '4', side: 0, tokenId: 'USDT', amount: '37', currencyId: 'PEN', price: '3.7', notifyTokenQuantity: '10', fee: '0', targetNickName: 'd', status: 70, createDate: String(S + 4000) },
  ];
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'POST');
    const h = init.headers;
    assert.equal(h['X-BAPI-SIGN'], crypto.createHmac('sha256', 'SEC').update(h['X-BAPI-TIMESTAMP'] + 'K' + h['X-BAPI-RECV-WINDOW'] + init.body).digest('hex'));
    const b = JSON.parse(init.body);
    return resp(200, { ret_code: 0, ret_msg: 'SUCCESS', result: { count: items.length, items: b.page === 1 ? items : [] } });
  };
  const r = await ADAPTERS.bybit({ apiKey: 'K', apiSecret: 'SEC' }, S, E, { fetchImpl, sleepImpl: noSleep });
  const by = Object.fromEntries(r.candidates.map((c) => [c.orderId, c]));
  assert.equal(by['1'].side, 'buy', 'la versión anterior invertía compra/venta');
  assert.equal(by['2'].side, 'sell');
  assert.equal(by['1'].amount, '100'); assert.equal(by['1'].total, '370');
  assert.equal(by['3'].status, 'cancelado', 'la versión anterior marcaba canceladas como pendientes');
  assert.equal(by['4'].status, 'fallido');
});

test('Bitget: count = cripto, amount = fiat; paginación por idLessThan', async () => {
  let n = 0;
  const mk = (i) => ({ orderId: String(i), orderNo: `B${i}`, side: i % 2 ? 'sell' : 'buy', coin: 'USDT', fiat: 'PEN', count: '10', amount: '37', price: '3.7', status: 'completed', ctime: String(S + i * 1000), buyerRealName: 'X', sellerRealName: 'Y' });
  const fetchImpl = async (url) => {
    n++;
    const u = new URL(url);
    const from = u.searchParams.get('idLessThan') ? Number(u.searchParams.get('idLessThan')) : 250;
    const list = []; for (let i = from - 1; i >= Math.max(0, from - 100); i--) list.push(mk(i));
    return resp(200, { code: '00000', data: { orderList: list, minOrderId: String(Math.max(0, from - 100)) } });
  };
  const r = await ADAPTERS.bitget({ apiKey: 'K', apiSecret: 'S', passphrase: 'P' }, S, E, { fetchImpl, sleepImpl: noSleep });
  assert.equal(r.candidates.length, 250);
  assert.equal(r.candidates[0].amount, '10'); assert.equal(r.candidates[0].total, '37');
  assert.equal(r.candidates.find((c) => c.side === 'buy').counterparty, 'Y', 'en una compra la contraparte es el vendedor');
  assert.equal(r.candidates.find((c) => c.side === 'sell').counterparty, 'X');
  assert.equal(new Set(r.candidates.map((c) => c.orderId)).size, 250, 'sin repetidos entre páginas');
});

test('HTTP: reintenta 429/5xx respetando Retry-After y agota el tiempo de espera', async () => {
  let k = 0;
  const waits = [];
  const data = await requestJson('https://x', { fetchImpl: async () => (++k < 3 ? resp(k === 1 ? 429 : 503, 'busy', { 'retry-after': '2' }) : resp(200, { ok: 1 })), sleepImpl: async (ms) => waits.push(ms) });
  assert.deepEqual(data, { ok: 1 });
  assert.deepEqual(waits, [2000, 2000]);
  await assert.rejects(requestJson('https://x', { retries: 0, timeoutMs: 30, fetchImpl: (u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) }), /tiempo de espera/);
  await assert.rejects(requestJson('https://x', { retries: 0, fetchImpl: async () => resp(404, '<html>') }), /no es JSON/);
});

test('sincronización todo-o-nada: un fallo a mitad de paginación no guarda datos parciales', async () => {
  let page2 = 'fail';
  const buys = Array.from({ length: 60 }, (_, i) => binanceOrder(i, 'BUY'));
  const fetchImpl = async (url) => {
    if (url.includes('/api/v3/time')) return resp(200, { serverTime: Date.now() });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page'));
    if (u.searchParams.get('tradeType') === 'SELL') return resp(200, { code: '000000', data: [] });
    if (page === 2 && page2 === 'fail') return resp(500, 'err');
    if (page === 2 && page2 === 'bad') return resp(200, { code: '000000', data: [{ orderNumber: 'x' }] });
    return resp(200, { code: '000000', total: 60, data: buys.slice((page - 1) * 50, page * 50) });
  };
  const h = await startApp({ fetchImpl, sleepImpl: noSleep });
  try {
    await h.call('POST', '/api/v1/exchange/connect', { exchange: 'Binance', apiKey: 'K', apiSecret: 'S' });
    let r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-09' });
    assert.equal(r.status, 502);
    assert.equal(r.data.success, false);
    assert.match(r.data.error, /No se guardó/);
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 0);

    page2 = 'bad';
    r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-09' });
    assert.equal(r.status, 422);
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 0);

    page2 = 'ok';
    r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-09' });
    assert.equal(r.status, 200);
    assert.equal(r.data.newImported, 60);
    r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-09' });
    assert.equal(r.data.newImported, 0, 'resincronizar no duplica');
    assert.equal(r.data.unchanged, 60);
    buys[0].orderStatus = 'CANCELLED';
    r = await h.call('POST', '/api/v1/sync/binance', { startDate: '2026-09-01', endDate: '2026-09-09' });
    assert.equal(r.data.updated, 1);
    assert.equal(r.data.statusChanges[0].changes.find((c) => c.field === 'status').to, 'cancelado');
    const t = (await h.call('GET', '/api/v1/trades?status=cancelado')).data.trades[0];
    assert.equal(t.countable, false);
    const trace = (await h.call('GET', `/api/v1/trades/${t.id}/trace`)).data;
    assert.equal(trace.trade.history.length, 1, 'el cambio de estado queda en el historial');
  } finally { await h.close(); }
});

test('OKX y El Dorado explican que no hay API P2P y sugieren importar archivo', async () => {
  const h = await startApp();
  try {
    const r = await h.call('POST', '/api/v1/exchange/connect', { exchange: 'okx', apiKey: 'a', apiSecret: 'b' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /RFQ/);
    const s = await h.call('POST', '/api/v1/sync/el dorado', {});
    assert.match(s.data.error, /Importe/);
  } finally { await h.close(); }
});

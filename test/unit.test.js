'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/dates');
const { parseAmount, detectDecimalSeparator } = require('../src/numbers');
const m = require('../src/model');

const iso = (s, o) => { const r = d.parseSourceDate(s, o); return r.ok ? new Date(r.ms).toISOString() : `ERR ${r.error}`; };

test('fechas: hora local de Lima → UTC sin desplazamientos', () => {
  assert.equal(iso('2026-09-01 20:30:00'), '2026-09-02T01:30:00.000Z');
  assert.equal(iso('2026-09-01T20:30'), '2026-09-02T01:30:00.000Z');
  assert.equal(iso('\t2026-09-01 20:30:15'), '2026-09-02T01:30:15.000Z', 'tab inicial de exportaciones');
  assert.equal(iso('2026-09-01 08:30:00 PM'), '2026-09-02T01:30:00.000Z');
  assert.equal(iso('2026-09-01 12:05:00 AM'), '2026-09-01T05:05:00.000Z');
});

test('fechas: zonas explícitas y epoch se respetan', () => {
  assert.equal(iso('2026-09-01T20:30:00Z'), '2026-09-01T20:30:00.000Z');
  assert.equal(iso('2026-09-01 20:30:00 +08:00'), '2026-09-01T12:30:00.000Z');
  assert.equal(iso('2026-09-01 20:30:00 (UTC+8)'), '2026-09-01T12:30:00.000Z');
  assert.equal(iso('1756776600000'), '2025-09-02T01:30:00.000Z');
  assert.equal(iso('1756776600'), '2025-09-02T01:30:00.000Z');
  assert.equal(iso('2026-09-01 20:30:00', { tz: 'UTC' }), '2026-09-01T20:30:00.000Z');
  assert.equal(iso('2026-09-01 20:30:00', { tz: 'Asia/Shanghai' }), '2026-09-01T12:30:00.000Z');
});

test('fechas: día/mes ambiguo no se adivina; inválidas se rechazan', () => {
  assert.match(iso('01/09/2026 10:00'), /ambigua/);
  assert.equal(iso('01/09/2026 10:00', { dateOrder: 'DMY' }), '2026-09-01T15:00:00.000Z');
  assert.equal(iso('01/09/2026 10:00', { dateOrder: 'MDY' }), '2026-01-09T15:00:00.000Z');
  assert.equal(iso('25/09/2026 10:00'), '2026-09-25T15:00:00.000Z');
  assert.match(iso('31/02/2026'), /inválida/);
  assert.match(iso('2026-13-01'), /inválida/);
  assert.match(iso('ayer'), /no reconocido/);
  assert.equal(d.detectDateOrder(['01/09/2026', '25/09/2026']), 'DMY');
  assert.equal(d.detectDateOrder(['09/25/2026', '09/01/2026']), 'MDY');
  assert.equal(d.detectDateOrder(['25/09/2026', '09/25/2026']), 'INCONSISTENT');
});

test('fechas: límites de rango son días completos en hora de Lima', () => {
  assert.equal(new Date(d.rangeBoundary('2026-09-01', 'start')).toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(new Date(d.rangeBoundary('2026-09-01', 'end')).toISOString(), '2026-09-02T05:00:00.000Z');
  assert.equal(d.toLocalMinute(Date.parse('2026-09-02T01:30:00Z')), '2026-09-01T20:30');
  // fin de mes/año
  assert.equal(new Date(d.rangeBoundary('2026-12-31', 'end')).toISOString(), '2027-01-01T05:00:00.000Z');
});

test('números: separadores y unidades', () => {
  const v = (s, dec) => { const r = parseAmount(s, dec); return r.ok ? r.value : `ERR`; };
  assert.equal(v('1,234.56'), '1234.56');
  assert.equal(v('1.234,56'), '1234.56');
  assert.equal(v('3,75'), '3.75');
  assert.equal(v('0.750'), '0.75');
  assert.equal(v('1.500'), 'ERR', 'ambiguo sin contexto');
  assert.equal(v('1.500', '.'), '1.5');
  assert.equal(v('1.500', ','), '1500');
  assert.equal(v('S/ 1,200.00'), '1200');
  assert.equal(v('70.0000 USDT'), '70');
  assert.equal(v('"\t100.25"'), '100.25');
  assert.equal(v('1.500.000'), '1500000');
  assert.equal(v('12,34,5'), 'ERR');
  assert.equal(v('abc'), 'ERR');
  assert.equal(v(0.1 + 0.2), '0.30000000000000004', 'los números JS se toman tal cual (por eso se usan strings)');
  assert.equal(detectDecimalSeparator(['1.500', '3,75']), ',');
  assert.equal(detectDecimalSeparator(['1.5', '3,75']), 'INCONSISTENT');
});

test('estados: solo "completado" se contabiliza; nada desconocido pasa como completado', () => {
  const cases = { COMPLETED: 'completado', Completed: 'completado', Finalizado: 'completado', CANCELLED_BY_SYSTEM: 'cancelado',
    Cancelado: 'cancelado', expired: 'cancelado', pending_pay: 'pendiente', BUYER_PAYED: 'pendiente', Paid: 'pendiente',
    IN_APPEAL: 'en_disputa', Appeal: 'en_disputa', rejected: 'fallido', 'pay fail': 'fallido', '': 'desconocido', raro: 'desconocido' };
  for (const [raw, exp] of Object.entries(cases)) assert.equal(m.normalizeStatus(raw), exp, raw);
});

test('lado: compras y ventas en inglés/español (el backend anterior convertía "SELL" en compra)', () => {
  assert.equal(m.normalizeSide('SELL'), 'sell');
  assert.equal(m.normalizeSide('Sell'), 'sell');
  assert.equal(m.normalizeSide('Venta'), 'sell');
  assert.equal(m.normalizeSide('BUY'), 'buy');
  assert.equal(m.normalizeSide('Compra'), 'buy');
  assert.equal(m.normalizeSide('transfer'), null);
});

test('buildTrade: derivaciones explícitas, rechazos con motivo, sin valores por defecto silenciosos', () => {
  let r = m.buildTrade({ exchange: 'bybit', orderId: '1', side: 'buy', crypto: 'usdt', fiat: 'pen', amount: '100', total: '375', status: 'completed', date: '2026-09-01 10:00' });
  assert.equal(r.trade.price, '3.75');
  assert.deepEqual(r.trade.derived, ['precio = total / cantidad']);
  assert.equal(r.trade.exchange, 'Bybit');
  assert.equal(r.trade.pair, 'USDT/PEN');
  assert.equal(r.trade.id, 'bybit_1');

  r = m.buildTrade({ exchange: 'Binance', side: 'buy', amount: '1', total: '3', status: 'completed', date: '2026-09-01' });
  assert.ok(r.rejected.reasons.some((x) => /cripto/.test(x)));
  assert.ok(r.rejected.reasons.some((x) => /fiat/.test(x)), 'la moneda fiat ya no se asume PEN');

  r = m.buildTrade({ exchange: 'Binance', side: 'buy', crypto: 'USDT', fiat: 'PEN', amount: '1', total: '3', date: '2026-09-01' }, { source: 'csv' });
  assert.equal(r.trade.status, 'desconocido', 'un estado ausente en archivo NO se asume completado');
  assert.ok(!m.isCountable(r.trade));
});

test('validateTrade: inconsistencias marcadas y operaciones bloqueadas', () => {
  const base = { exchange: 'Binance', orderId: 'x', side: 'buy', crypto: 'USDT', fiat: 'PEN', status: 'completado', date: '2026-09-01 10:00' };
  let t = m.buildTrade({ ...base, amount: '100', price: '3.75', total: '375.2' }).trade;
  assert.equal(m.validateTrade(t).filter((i) => i.code === 'TOTAL_INCONSISTENTE').length, 0, 'redondeo menor tolerado');
  t = m.buildTrade({ ...base, amount: '100', price: '3.75', total: '380' }).trade;
  assert.equal(m.validateTrade(t).find((i) => i.code === 'TOTAL_INCONSISTENTE').severity, 'warning');
  t = m.buildTrade({ ...base, amount: '375', price: '3.75', total: '100' }).trade;
  assert.equal(m.validateTrade(t).find((i) => i.code === 'TOTAL_INCONSISTENTE').severity, 'error');
  assert.equal(m.isCountable(t), false);
  t = m.buildTrade({ ...base, amount: '100', price: '3.75', total: '375', fee: '1', feeAsset: 'BTC' }).trade;
  assert.ok(m.validateTrade(t).some((i) => i.code === 'COMISION_MONEDA' && i.severity === 'error'));
  t = m.buildTrade({ ...base, amount: '100', price: '3.75', total: '375', fee: '0.1', feeAsset: 'USDT' }).trade;
  assert.equal(m.isCountable(t), true);
});

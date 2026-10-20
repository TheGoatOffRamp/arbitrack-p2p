'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compute } = require('../src/accounting/engine');
const { D } = require('../src/money');
const { T } = require('./helpers');

const eq = (a, b, msg) => assert.equal(D(a).toFixed(), D(b).toFixed(), msg);
const st = (trades, extra = {}) => ({ trades, costs: [], cycles: [], ...extra });

test('FIFO con comisiones en cripto y en fiat — valores calculados a mano', () => {
  const trades = [
    T({ exchange: 'Binance', side: 'buy', amount: '100', price: '3.70', total: '370', fee: '0.1', feeAsset: 'USDT', date: '2026-09-01 09:00' }),
    T({ exchange: 'Bybit', side: 'buy', amount: '50', price: '3.72', total: '186', date: '2026-09-01 09:30' }),
    T({ exchange: 'El Dorado', side: 'sell', amount: '120', price: '3.76', total: '451.2', fee: '1.2', feeAsset: 'PEN', date: '2026-09-01 10:00' }),
    T({ exchange: 'Bybit', side: 'sell', amount: '29.8', price: '3.75', total: '111.75', fee: '0.1', feeAsset: 'USDT', date: '2026-09-01 11:00' }),
  ];
  const r = compute(st(trades));
  const [c1, c2] = r.cycles;
  // Ciclo 1: 99.9 del lote 1 (costo 369.63 + comisión 0.37) + 20.1 del lote 2 (74.772)
  eq(c1.costBasis, '444.402'); eq(c1.gross, '6.798'); eq(c1.fees, '1.57'); eq(c1.net, '5.228');
  assert.deepEqual(c1.buyExchanges, ['Binance', 'Bybit']);
  assert.equal(c1.sellExchange, 'El Dorado');
  // Ciclo 2: 29.8 × 3.72 = 110.856; comisión 0.1 USDT al costo 3.72 = 0.372
  eq(c2.costBasis, '110.856'); eq(c2.gross, '0.894'); eq(c2.fees, '0.372'); eq(c2.net, '0.522');
  const p = r.pairs[0];
  eq(p.net, '5.75'); eq(p.gross, '7.692'); eq(p.fees, '1.942');
  eq(p.closingInventory.qty, '0');
  assert.ok(p.reconciliation.ok);
  eq(p.reconciliation.cashNet, '5.75');
});

test('pendientes, canceladas, fallidas, en disputa y desconocidas no afectan resultados ni inventario', () => {
  const base = [
    T({ side: 'buy', amount: '100', price: '3.7', total: '370', date: '2026-09-01 09:00' }),
    T({ side: 'sell', amount: '100', price: '3.8', total: '380', date: '2026-09-01 10:00' }),
  ];
  const noise = ['pendiente', 'cancelado', 'fallido', 'en_disputa', 'raro'].flatMap((s, i) => [
    T({ side: 'buy', amount: '1000', price: '3.0', total: '3000', status: s, date: `2026-09-01 0${i}:10` }),
    T({ side: 'sell', amount: '1000', price: '9.0', total: '9000', status: s, date: `2026-09-01 1${i}:20` }),
  ]);
  const a = compute(st(base)), b = compute(st([...base, ...noise]));
  eq(a.pairs[0].net, '10'); eq(b.pairs[0].net, '10');
  eq(b.pairs[0].buys.qty, '100'); eq(b.pairs[0].closingInventory.qty, '0');
  assert.equal(b.cycles.length, 1);
  assert.equal([...b.tradeInfo.values()].filter((i) => !i.countable).length, 10);
});

test('pares distintos NUNCA se mezclan (USDT/PEN vs USDT/USD vs BTC/PEN vs USDC/PEN)', () => {
  const trades = [
    T({ side: 'buy', crypto: 'USDT', fiat: 'PEN', amount: '100', price: '3.7', total: '370', date: '2026-09-01 09:00' }),
    T({ side: 'sell', crypto: 'USDT', fiat: 'PEN', amount: '100', price: '3.75', total: '375', date: '2026-09-01 12:00' }),
    T({ side: 'sell', crypto: 'USDT', fiat: 'USD', amount: '50', price: '1.01', total: '50.5', date: '2026-09-01 10:00' }),
    T({ side: 'buy', crypto: 'BTC', fiat: 'PEN', amount: '0.01', price: '400000', total: '4000', date: '2026-09-01 10:30' }),
    T({ side: 'sell', crypto: 'USDC', fiat: 'PEN', amount: '10', price: '3.8', total: '38', date: '2026-09-01 11:00' }),
  ];
  const r = compute(st(trades));
  const by = Object.fromEntries(r.pairs.map((p) => [p.pair, p]));
  assert.deepEqual(Object.keys(by).sort(), ['BTC/PEN', 'USDC/PEN', 'USDT/PEN', 'USDT/USD']);
  eq(by['USDT/PEN'].net, '5');
  eq(by['USDT/PEN'].costOfSales, '370', 'la venta USDT/USD no consumió inventario USDT/PEN');
  eq(by['USDT/USD'].net, '0', 'venta sin compra: no se reconoce ganancia');
  eq(by['USDT/USD'].unrecognizedProceeds, '50.5');
  eq(by['BTC/PEN'].closingInventory.qty, '0.01');
  assert.ok(r.issues.some((i) => i.code === 'VENTA_SIN_COMPRA' && i.pair === 'USDT/USD'));
  assert.ok(r.issues.some((i) => i.code === 'VENTA_SIN_COMPRA' && i.pair === 'USDC/PEN'));
  assert.ok(r.issues.some((i) => i.code === 'COMPRA_SIN_VENTA' && i.pair === 'BTC/PEN'));
});

test('venta parcialmente sin compra: solo se reconoce la parte con costo', () => {
  const r = compute(st([
    T({ side: 'buy', amount: '60', price: '3.7', total: '222', date: '2026-09-01 09:00' }),
    T({ side: 'sell', amount: '100', price: '3.8', total: '380', date: '2026-09-01 10:00' }),
  ]));
  const c = r.cycles[0];
  assert.equal(c.status, 'incompleto');
  eq(c.proceeds, '228'); eq(c.costBasis, '222'); eq(c.net, '6'); eq(c.unrecognizedProceeds, '152');
  assert.ok(r.pairs[0].reconciliation.ok);
});

test('otros costos: fiat directo y cripto al costo FIFO; incompatible se rechaza', () => {
  const trades = [
    T({ side: 'buy', amount: '100', price: '3.7', total: '370', date: '2026-09-01 09:00' }),
    T({ side: 'sell', amount: '99', price: '3.8', total: '376.2', date: '2026-09-01 12:00' }),
  ];
  const costs = [
    { id: 'c1', dateUtc: '2026-09-01T15:00:00.000Z', pair: 'USDT/PEN', asset: 'USDT', amount: '1', description: 'red TRC20' },
    { id: 'c2', dateUtc: '2026-09-01T16:00:00.000Z', pair: 'USDT/PEN', asset: 'PEN', amount: '2.5', description: 'ITF banco' },
    { id: 'c3', dateUtc: '2026-09-01T16:00:00.000Z', pair: 'USDT/PEN', asset: 'BTC', amount: '1', description: 'error' },
  ];
  const r = compute(st(trades, { costs }));
  const p = r.pairs[0];
  eq(p.gross, '9.9'); eq(p.otherCosts, '6.2'); eq(p.net, '3.7');
  eq(p.closingInventory.qty, '0');
  assert.ok(p.reconciliation.ok);
  assert.ok(r.issues.some((i) => i.code === 'COSTO_MONEDA'));
});

test('ciclos manuales: inventario propio, costos del ciclo, estados y par incompatible', () => {
  const cycles = [{ id: 'M1', name: 'Ciclo A', pair: 'USDT/PEN' }];
  const trades = [
    T({ side: 'buy', amount: '100', price: '3.6', total: '360', date: '2026-09-01 08:00' }), // pool automático
    T({ side: 'buy', amount: '100', price: '3.7', total: '370', date: '2026-09-01 09:00', cycleId: 'M1' }),
    T({ side: 'sell', amount: '100', price: '3.8', total: '380', date: '2026-09-01 10:00', cycleId: 'M1' }),
    T({ side: 'sell', amount: '1', crypto: 'BTC', price: '1', total: '1', date: '2026-09-01 10:00', cycleId: 'M1' }),
    T({ side: 'sell', amount: '100', price: '3.65', total: '365', date: '2026-09-01 11:00' }),
  ];
  const costs = [{ id: 'k', dateUtc: '2026-09-01T16:00:00.000Z', pair: 'USDT/PEN', asset: 'PEN', amount: '1', description: 'transferencia', cycleId: 'M1' }];
  const r = compute(st(trades, { cycles, costs }));
  const man = r.cycles.find((c) => c.id === 'M1');
  eq(man.costBasis, '370', 'usa su propio lote, no el de 3.6'); eq(man.gross, '10'); eq(man.otherCosts, '1'); eq(man.net, '9');
  assert.equal(man.status, 'completo');
  const auto = r.cycles.find((c) => c.kind === 'automatico');
  eq(auto.costBasis, '360'); eq(auto.net, '5');
  assert.ok(r.issues.some((i) => i.code === 'CICLO_PAR_INCOMPATIBLE'));
  const p = r.pairs.find((x) => x.pair === 'USDT/PEN');
  eq(p.net, '14'); assert.ok(p.reconciliation.ok);
});

test('período: el inventario previo se arrastra a costo y el resultado se reconoce en la venta', () => {
  const trades = [
    T({ side: 'buy', amount: '100', price: '3.7', total: '370', date: '2026-08-31 23:59' }),
    T({ side: 'sell', amount: '100', price: '3.8', total: '380', date: '2026-09-01 00:00' }),
  ];
  const { rangeBoundary } = require('../src/dates');
  const r = compute(st(trades), { fromMs: rangeBoundary('2026-09-01', 'start'), toMs: rangeBoundary('2026-09-30', 'end') });
  const p = r.pairs[0];
  eq(p.openingInventory.qty, '100'); eq(p.openingInventory.cost, '370');
  eq(p.buys.count, 0); eq(p.net, '10'); assert.ok(p.reconciliation.ok);
  const ago = compute(st(trades), { fromMs: rangeBoundary('2026-08-01', 'start'), toMs: rangeBoundary('2026-08-31', 'end') });
  eq(ago.pairs[0].net, '0'); eq(ago.pairs[0].closingInventory.cost, '370');
});

test('operaciones simultáneas (mismo segundo): la compra se procesa antes que la venta', () => {
  const r = compute(st([
    T({ side: 'sell', amount: '10', price: '3.8', total: '38', date: '2026-09-01 10:00' }),
    T({ side: 'buy', amount: '10', price: '3.7', total: '37', date: '2026-09-01 10:00' }),
  ]));
  eq(r.pairs[0].net, '1');
  assert.equal(r.cycles[0].status, 'completo');
});

test('posibles duplicados con distinto ID se marcan (no se borran)', () => {
  const r = compute(st([
    T({ orderId: null, side: 'buy', amount: '10', price: '3.7', total: '37', counterparty: 'ana', date: '2026-09-01 10:00' }),
    T({ orderId: 'Z1', side: 'buy', amount: '10', price: '3.7', total: '37', counterparty: 'ana', date: '2026-09-01 10:01' }),
  ]));
  assert.ok(r.issues.some((i) => i.code === 'POSIBLE_DUPLICADO'));
  eq(r.pairs[0].buys.qty, '20');
});

test('propiedad: con 2 000 escenarios aleatorios la conciliación siempre cuadra y Σ ciclos = neta', () => {
  let rnd = 42;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 0; k < 2000; k++) {
    const trades = [];
    const n = 2 + Math.floor(rand() * 10);
    for (let i = 0; i < n; i++) {
      const side = rand() < 0.55 ? 'buy' : 'sell';
      const amount = (1 + rand() * 500).toFixed(4);
      const price = (3.5 + rand() * 0.4).toFixed(4);
      const total = D(amount).times(price).toDecimalPlaces(2).toFixed();
      const feeKind = rand();
      const fee = feeKind < 0.33 ? '0' : feeKind < 0.66 ? D(amount).times('0.001').toDecimalPlaces(4).toFixed() : D(total).times('0.002').toDecimalPlaces(2).toFixed();
      trades.push(T({ side, amount, price, total, fee, feeAsset: feeKind < 0.66 ? 'USDT' : 'PEN', status: rand() < 0.85 ? 'completado' : 'pendiente',
        date: `2026-09-${String(1 + Math.floor(rand() * 28)).padStart(2, '0')} ${String(Math.floor(rand() * 24)).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}` }));
    }
    const r = compute(st(trades));
    for (const p of r.pairs) {
      assert.ok(p.reconciliation.ok, `escenario ${k}: diferencia ${p.reconciliation.difference}`);
      const sumCycles = r.cycles.filter((c) => c.pair === p.pair).reduce((a, c) => a.plus(c.net), D(0));
      eq(sumCycles.minus(p.otherCosts), p.net, `escenario ${k}`);
      assert.ok(!p.closingInventory.qty.isNegative());
    }
  }
});

test('volumen: 50 000 operaciones se procesan en tiempo razonable', () => {
  const trades = [];
  const t0 = Date.parse('2026-01-01T05:00:00Z');
  for (let i = 0; i < 50000; i++) {
    const side = i % 2 ? 'sell' : 'buy';
    const iso = new Date(t0 + i * 60000).toISOString();
    trades.push({ ...T({ side, amount: '100', price: side === 'buy' ? '3.7' : '3.72', total: side === 'buy' ? '370' : '372', dateUtc: iso }), id: `v${i}`, orderId: `v${i}` });
  }
  const start = Date.now();
  const r = compute(st(trades));
  const ms = Date.now() - start;
  eq(r.pairs[0].net, '50000');
  assert.equal(r.cycles.length, 25000);
  assert.ok(ms < 15000, `tardó ${ms} ms`);
});

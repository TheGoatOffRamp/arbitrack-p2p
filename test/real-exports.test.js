'use strict';
// Formatos reales de exportación (sep-2026), con contrapartes anonimizadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCsv, parseXlsx } = require('../src/importers/tabular');
const { analyze } = require('../src/importers/importer');
const { toLocalFull } = require('../src/dates');
const { startApp } = require('./helpers');

const F = (n) => path.join(__dirname, 'fixtures', n);
const csv = (n, opts = {}) => analyze(parseCsv(fs.readFileSync(F(n), 'utf8')).rows, { filename: n, ...opts });
const lima = (t) => toLocalFull(Date.parse(t.dateUtc));
const byId = (a, id) => a.trades.find((t) => t.orderId === id);

test('Bitget real: "Flat" = fiat, "Amount" = fiat, "Quantity" = cripto, TAB inicial en el N° de orden', () => {
  const a = csv('bitget_real.csv');
  assert.equal(a.status, 'ok');
  assert.equal(a.detection.exchange, 'Bitget');
  const t = byId(a, '1477207716497215489');
  assert.ok(t, 'el TAB inicial se elimina del N° de orden');
  assert.equal(t.side, 'sell'); assert.equal(t.pair, 'USDT/PEN');
  assert.equal(t.amount, '118.69'); assert.equal(t.total, '400'); assert.equal(t.price, '3.37');
  assert.equal(t.status, 'completado');
  assert.equal(a.options.tzSource, 'supuesta', 'Bitget no indica zona: se avisa');
  assert.ok(a.warnings.some((w) => /no indica su zona horaria/.test(w)));
  assert.equal(t.feeUnknown, true);
});

test('Bybit pasado por Google Sheets: números alterados se reconstruyen y se verifican', () => {
  const a = csv('bybit_sheets.csv');
  assert.equal(a.status, 'ok');
  assert.equal(a.detection.exchange, 'Bybit');
  assert.deepEqual(a.options.repairedColumns, ['Coin Amount', 'Fiat Amount']);
  const t1 = byId(a, '2090644624207253504');
  assert.equal(t1.side, 'buy'); assert.equal(t1.amount, '290.3501'); assert.equal(t1.total, '970.931'); assert.equal(t1.price, '3.344');
  const t2 = byId(a, '2088442512966631424');
  assert.equal(t2.total, '1022.516', '"1.022.516" → 1022.516'); assert.equal(t2.amount, '306.1425');
  assert.equal(byId(a, '2083575391953846272').amount, '5.8377', 'los valores que conservaron el punto no cambian');
  assert.equal(byId(a, '2083571146030546944').total, '1000', '"1.000.000" → 1000');
  assert.equal(byId(a, '2082502250382659584').status, 'cancelado');
  assert.equal(a.options.tzSource, 'id de orden', 'la hora se verifica con el ID snowflake de Bybit');
  assert.equal(lima(t1), '2026-08-20 22:38:16');
  assert.ok(a.trades.every((t) => !a.issues.some((i) => i.id === t.id && i.code === 'TOTAL_INCONSISTENTE')));
  assert.ok(t2.derived.some((d) => /reconstruidos/.test(d)), 'cada fila reconstruida queda documentada');
});

test('Bybit: si no hay valores inequívocos para ubicar el decimal, NO se adivina', () => {
  const text = fs.readFileSync(F('bybit_sheets.csv'), 'utf8').split('\n')
    .filter((l, i) => i === 0 || !/,\d\.\d{4},USDT/.test(l)).join('\n'); // quita las filas "ancla" (p. ej. 5.8377)
  const a = analyze(parseCsv(text).rows, { filename: 'bybit.csv' });
  assert.equal(a.status, 'error');
  assert.match(a.blocking[0], /no se pueden interpretar con seguridad/);
});

test('OKX en español: Volumen = cripto, Monto = fiat, Comprar/Vender, zona verificada con el N° de orden', () => {
  const a = csv('okx_es.csv');
  assert.equal(a.detection.exchange, 'OKX');
  assert.equal(a.options.tzSource, 'id de orden');
  assert.equal(a.options.tz, 'America/Lima');
  const t = byId(a, '260828133211114');
  assert.equal(t.side, 'sell'); assert.equal(t.crypto, 'USDT'); assert.equal(t.amount, '267.45'); assert.equal(t.total, '900');
  assert.equal(t.payMethod, 'Credit Bank of Peru');
  assert.equal(lima(t), '2026-08-28 00:32:13');
  assert.equal(byId(a, '260829011601147').status, 'cancelado');
  assert.equal(byId(a, '260828140136701').side, 'buy');
  assert.ok(a.trades.every((x) => x.exchange === 'OKX'), '"Fuente de orden" (P2P Order) no se confunde con el exchange');
  // Si la hora del archivo estuviera en otra zona, el ID lo detecta
  const shifted = fs.readFileSync(F('okx_es.csv'), 'utf8').replace(/2026-08-28 12:16:02/, '2026-08-28 17:16:02');
  assert.equal(analyze(parseCsv(shifted).rows, { filename: 'okx.csv' }).options.tz, 'America/Lima', 'una fila distinta no cambia la mayoría');
});

test('El Dorado XLSX: estado por "Orden Completada", precio exacto = FIAT ÷ cripto, comisión en USDT, USD separado', async () => {
  const { rows } = await parseXlsx(fs.readFileSync(F('eldorado_real.xlsx')));
  const a = analyze(rows, { filename: 'El_dorado_P2P_Septiembre.xlsx' });
  assert.equal(a.status, 'ok');
  assert.equal(a.detection.exchange, 'El Dorado');
  assert.equal(a.options.tzSource, 'id de orden', 'UUIDv7 confirma hora de Lima');
  const t = byId(a, '01a05b9d-d673-756a-9a2e-7f8e6b41c244');
  assert.equal(t.status, 'completado');
  assert.equal(t.amount, '56.62'); assert.equal(t.total, '185.42');
  assert.equal(t.price, '3.2748145532', 'la tasa 3.28 del archivo viene redondeada; se usa 185.42 ÷ 56.62');
  assert.equal(t.fee, '0.14'); assert.equal(t.feeAsset, 'USDT');
  assert.equal(t.payMethod, 'Yape');
  assert.equal(t.exchange, 'El Dorado', '"Comerciante" (owli) no se toma como exchange');
  assert.equal(lima(t), '2026-09-01 01:17:45');
  assert.deepEqual(Object.keys(a.summary.byPair).sort(), ['USDT/PEN', 'USDT/USD']);
  assert.equal(a.issues.filter((i) => i.code === 'TOTAL_INCONSISTENTE').length, 0);
});

test('los cuatro archivos se importan automáticamente, sin preguntas, y reimportar no duplica', async () => {
  const h = await startApp();
  try {
    const files = [
      ['bitget_real.csv', { content: fs.readFileSync(F('bitget_real.csv'), 'utf8') }],
      ['bybit.csv - bybit.csv.csv', { content: fs.readFileSync(F('bybit_sheets.csv'), 'utf8') }],
      ['OKX_3.csv', { content: fs.readFileSync(F('okx_es.csv'), 'utf8') }],
      ['El_dorado_P2P_Septiembre.xlsx', { contentBase64: fs.readFileSync(F('eldorado_real.xlsx')).toString('base64') }],
    ];
    let total = 0;
    for (const [name, payload] of files) {
      const r = await h.call('POST', '/api/v1/import/file', { filename: name, ...payload, commit: true });
      assert.equal(r.status, 200, `${name}: ${r.data.error || r.data.blocking}`);
      assert.equal(r.data.committed, true);
      total += r.data.result.inserted;
    }
    const again = await h.call('POST', '/api/v1/import/file', { filename: 'OKX_3.csv', content: fs.readFileSync(F('okx_es.csv'), 'utf8'), commit: true });
    assert.equal(again.data.result.inserted, 0);
    const list = (await h.call('GET', '/api/v1/trades')).data;
    assert.equal(list.total, total);
    const st = (await h.call('GET', '/api/v1/stats')).data;
    assert.equal(st.pair, 'USDT/PEN');
    assert.ok(st.byPair.some((p) => p.pair === 'USDT/USD'));
    const x = await h.call('GET', '/api/v1/export/excel');
    assert.equal(x.status, 200);
  } finally { await h.close(); }
});

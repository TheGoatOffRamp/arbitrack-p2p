'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { startApp, tmpDir } = require('./helpers');

const ELDORADO = `ID;Tipo;Criptomoneda;Moneda Fiat;Cantidad de cripto;Precio;Cantidad de FIAT;Comisión;Estado;Fecha;Contraparte
ED-1;Compra;USDT;PEN;100,00;3,70;370,00;0;Completado;25/09/2026 21:05;Luis
ED-2;Venta;USDT;PEN;100,00;3,76;376,00;0;Completado;26/09/2026 08:00;Rosa
ED-3;Venta;USDT;PEN;50,00;3,76;188,00;0;Pendiente;26/09/2026 09:00;Rosa
ED-4;Compra;BTC;PEN;0,01;400.000,00;4.000,00;0;Completado;26/09/2026 10:00;Beto`;

test('regresión de rutas heredadas: health, crear, editar (PUT y POST), listar, eliminar', async () => {
  const h = await startApp();
  try {
    assert.equal((await h.call('GET', '/health')).data.status, 'ok');
    let r = await h.call('POST', '/api/v1/trades', { type: 'compra', date: '2026-09-01T10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.7, total: 370, fee: 0.1, feeType: 'crypto', status: 'completado' });
    assert.equal(r.status, 200);
    const id = r.data.trade.id;
    assert.equal(r.data.trade.date, '2026-09-01T10:00', 'la hora de Lima se mantiene al volver a la webapp');
    assert.equal(r.data.trade.dateUtc, '2026-09-01T15:00:00.000Z');
    assert.equal(r.data.trade.feeType, 'crypto');
    r = await h.call('PUT', `/api/v1/trades/${id}`, { price: 3.71, total: 371, notes: 'corregido' });
    assert.equal(r.data.trade.price, 3.71);
    assert.deepEqual(r.data.trade.manualFields.sort(), ['price', 'total']);
    r = await h.call('POST', `/api/v1/trades/${id}`, { type: 'venta' });
    assert.equal(r.data.trade.side, 'sell');
    r = await h.call('POST', '/api/v1/trades', { id, notes: 'por id en body' });
    assert.equal(r.data.trade.notes, 'por id en body');
    r = await h.call('GET', '/api/v1/trades?type=venta');
    assert.equal(r.data.total, 1);
    assert.equal(r.data.trades[0].history.length, 3);
    r = await h.call('PUT', `/api/v1/trades/${id}`, { amount: -5 });
    assert.equal(r.status, 400);
    r = await h.call('POST', '/api/v1/trades', { type: 'compra', date: '2026-09-01T10:00', exchange: 'Binance', crypto: 'USDT', amount: 1, total: 3.7, status: 'completado' });
    assert.equal(r.status, 400, 'sin moneda fiat no se asume PEN');
    await h.call('DELETE', `/api/v1/trades/${id}`);
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 0);
    assert.equal((await h.call('GET', '/api/v1/trades?includeDeleted=true')).data.total, 1, 'eliminación trazable (no destructiva)');
    await h.call('POST', `/api/v1/trades/${id}/restore`);
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 1);
    assert.equal((await h.call('GET', '/api/v1/nada')).status, 404);
  } finally { await h.close(); }
});

test('importación heredada (/import): SELL es venta, reimportar no duplica, estado ausente no cuenta', async () => {
  const h = await startApp();
  try {
    const body = { trades: [
      { type: 'BUY', date: '2026-09-01T10:00', exchange: 'Bybit', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.70, total: 370, status: 'completado' },
      { type: 'SELL', date: '2026-09-01T11:00', exchange: 'Bybit', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.75, total: 375, status: 'completado' },
      { type: 'compra', date: '2026-09-02T10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'USD', amount: 50, price: 1.0, total: 50 },
    ] };
    let r = await h.call('POST', '/api/v1/import', body);
    assert.equal(r.data.imported, 3);
    r = await h.call('POST', '/api/v1/import', body);
    assert.equal(r.data.imported, 0);
    assert.equal(r.data.unchanged, 3);
    const s = (await h.call('GET', '/api/v1/stats')).data;
    assert.equal(s.pair, 'USDT/PEN');
    assert.equal(s.profit, 5, 'antes: −1490 por mezclar PEN, USD y tratar la venta como compra');
    assert.equal(s.sells, 1);
    assert.equal(s.excluded, 1);
    assert.equal(s.byPair.length, 1, 'USDT/USD sin estado no se contabiliza');
  } finally { await h.close(); }
});

test('importación de archivo: vista previa, registro, reimportación, actualización de estado y deshacer lote', async () => {
  const h = await startApp();
  try {
    let r = await h.call('POST', '/api/v1/import/file', { filename: 'eldorado.csv', content: ELDORADO });
    assert.equal(r.data.committed, false, 'sin commit solo es vista previa');
    assert.equal(r.data.detection.exchange, 'El Dorado');
    assert.equal(r.data.summary.firstOperation.interpretedAs, '2026-09-25 21:05:00 (hora de Lima)');
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 0);

    r = await h.call('POST', '/api/v1/import/file', { filename: 'eldorado.csv', content: ELDORADO, commit: true });
    assert.equal(r.data.result.inserted, 4);
    const batch1 = r.data.batchId;
    r = await h.call('POST', '/api/v1/import/file', { filename: 'eldorado.csv', content: ELDORADO, commit: true });
    assert.equal(r.data.result.inserted, 0);
    assert.equal(r.data.result.unchanged, 4);

    const dupInFile = ELDORADO + '\nED-1;Compra;USDT;PEN;100,00;3,70;370,00;0;Completado;25/09/2026 21:05;Luis';
    r = await h.call('POST', '/api/v1/import/file', { filename: 'dup.csv', content: dupInFile, commit: true });
    assert.equal(r.data.result.duplicatesInFile.length, 1);

    const updated = ELDORADO.replace('50,00;3,76;188,00;0;Pendiente', '50,00;3,76;188,00;0;Completado') + '\nED-5;Compra;USDT;PEN;50,00;3,70;185,00;0;Completado;27/09/2026 08:00;Luis';
    r = await h.call('POST', '/api/v1/import/file', { filename: 'eldorado2.csv', content: updated, commit: true });
    assert.equal(r.data.result.updated.length, 1);
    assert.equal(r.data.result.updated[0].changes[0].to, 'completado');
    assert.equal(r.data.result.inserted, 1);

    const st = (await h.call('GET', '/api/v1/stats?pair=USDT/PEN')).data;
    assert.equal(st.byPair.find((p) => p.pair === 'USDT/PEN').sells, 2);

    r = await h.call('DELETE', `/api/v1/import/batches/${batch1}`);
    assert.equal(r.data.removed, 0, 'no borra operaciones que también llegaron en otros lotes');
    const last = (await h.call('GET', '/api/v1/import/batches')).data.batches[0];
    r = await h.call('DELETE', `/api/v1/import/batches/${last.id}`);
    assert.equal(r.data.removed, 1);

    r = await h.call('POST', '/api/v1/import/file', { filename: 'x.csv', content: 'Fecha,Tipo,Amount,Crypto\n2026-01-01,Compra,1,USDT', commit: true });
    assert.equal(r.status, 422);
  } finally { await h.close(); }
});

test('ciclos manuales vía API: se rechaza mezclar pares; costos con moneda del par', async () => {
  const h = await startApp();
  try {
    await h.call('POST', '/api/v1/import/file', { filename: 'eldorado.csv', content: ELDORADO, commit: true });
    const trades = (await h.call('GET', '/api/v1/trades')).data.trades;
    const id = (o) => trades.find((t) => t.orderId === o).id;
    let r = await h.call('POST', '/api/v1/cycles', { name: 'Ciclo 25-sep', pair: 'USDT/PEN', tradeIds: [id('ED-1'), id('ED-4')] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /BTC\/PEN/);
    r = await h.call('POST', '/api/v1/cycles', { name: 'Ciclo 25-sep', pair: 'USDT/PEN', tradeIds: [id('ED-1'), id('ED-2')] });
    const cid = r.data.cycle.id;
    r = await h.call('POST', '/api/v1/costs', { date: '2026-09-26 09:00', pair: 'USDT/PEN', asset: 'BTC', amount: 1, description: 'x' });
    assert.equal(r.status, 400);
    r = await h.call('POST', '/api/v1/costs', { date: '2026-09-26 09:00', pair: 'USDT/PEN', asset: 'PEN', amount: 1.5, description: 'ITF', cycleId: cid });
    assert.equal(r.status, 200);
    r = await h.call('PUT', `/api/v1/trades/${id('ED-4')}`, { cycleId: cid });
    assert.equal(r.status, 400);
    const cyc = (await h.call('GET', '/api/v1/cycles')).data.results.find((c) => c.id === cid);
    assert.equal(cyc.net, '4.5');
    assert.equal(cyc.status, 'completo');
  } finally { await h.close(); }
});

test('exportación Excel: hojas, fechas reales, totales por par y fórmulas coherentes', async () => {
  const h = await startApp();
  try {
    await h.call('POST', '/api/v1/import/file', { filename: 'eldorado.csv', content: ELDORADO, commit: true });
    await h.call('POST', '/api/v1/trades', { type: 'venta', date: '2026-09-26T12:00', exchange: 'Binance', crypto: 'USDT', fiat: 'USD', amount: 10, price: 1, total: 10, status: 'completado' });
    const r = await h.call('POST', '/api/v1/export/excel', { from: '2026-09-01', to: '2026-09-30', userName: 'Josh' });
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.data);
    const names = wb.worksheets.map((w) => w.name);
    assert.deepEqual(names, ['Resumen', 'Operaciones', 'Ciclos', 'Trazabilidad FIFO', 'Por moneda', 'Por exchange', 'Por período', 'Comisiones', 'Otros costos', 'Excluidas', 'Incidencias', 'Metodología']);
    const res = wb.getWorksheet('Resumen');
    const header = res.getRow(6).values.filter(Boolean);
    assert.deepEqual(header, ['Concepto', 'Unidad', 'BTC/PEN', 'USDT/PEN', 'USDT/USD']);
    const findRow = (ws, label) => { let found; ws.eachRow((row) => { if (row.getCell(1).value === label) found = row; }); return found; };
    const net = findRow(res, '= Ganancia neta');
    assert.equal(net.getCell(4).value, 6, 'USDT/PEN: 376 − 370');
    assert.equal(net.getCell(5).value, 0, 'USDT/USD: venta sin compra no genera ganancia');
    assert.equal(findRow(res, 'Diferencia vs. ganancia neta (debe ser 0)').getCell(4).value, 0);
    const ops = wb.getWorksheet('Operaciones');
    const first = ops.getRow(6);
    assert.ok(first.getCell(1).value instanceof Date, 'la fecha es una fecha real de Excel');
    assert.equal(first.getCell(1).value.toISOString(), '2026-09-25T21:05:00.000Z', 'se muestra 21:05 hora de Lima');
    assert.equal(first.getCell(3).value, 'ED-1');
    let opsCount = 0; ops.eachRow((row, n) => { if (n > 5) opsCount++; });
    assert.equal(opsCount, 4, 'la pendiente no está en Operaciones');
    const exc = wb.getWorksheet('Excluidas');
    assert.equal(exc.getRow(6).getCell(3).value, 'ED-3');
    const mon = wb.getWorksheet('Por moneda');
    const usdtRow = [...Array(10).keys()].map((i) => mon.getRow(5 + i)).find((row) => row.getCell(1).value === 'USDT/PEN');
    assert.match(usdtRow.getCell(5).value.formula, /^SUMIFS\(Operaciones!/);
    assert.equal(usdtRow.getCell(5).value.result, 370);
    const cyc = wb.getWorksheet('Ciclos');
    assert.equal(cyc.getRow(7).getCell(17).value, 6);
    fs.writeFileSync(path.join(h.dataDir, 'reporte.xlsx'), r.data);
  } finally { await h.close(); }
});

test('migración del trades.json antiguo: zonas horarias por origen, duplicados en cuarentena', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'trades.json'), JSON.stringify([
    { id: 'binance_1', orderId: '1', type: 'compra', date: '2026-09-02T01:30', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.7, total: 370, fee: 0, status: 'completado', source: 'api', syncId: 'binance_1' },
    { id: 'manual_9', orderId: '', type: 'venta', date: '2026-09-01T21:00', exchange: 'El Dorado', crypto: 'USDT', fiat: 'PEN', amount: 100, price: 3.76, total: 376, fee: 0, status: 'completado', source: 'manual' },
    { id: 'import_a', orderId: '', type: 'compra', date: '2026-09-03T10:00', exchange: 'Bybit', crypto: 'USDT', fiat: 'PEN', amount: 10, price: 3.7, total: 37, fee: 0, status: 'completado', source: 'import' },
    { id: 'import_b', orderId: '', type: 'compra', date: '2026-09-03T10:00', exchange: 'Bybit', crypto: 'USDT', fiat: 'PEN', amount: 10, price: 3.7, total: 37, fee: 0, status: 'completado', source: 'import' },
    { id: 'roto', type: 'compra', date: 'x', exchange: 'Bybit', amount: 1 },
  ]));
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ binance: { apiKey: 'AAAABBBBCCCC', apiSecret: 'S', connectedAt: 'x' } }));
  const h = await startApp({ dataDir: dir });
  try {
    const trades = (await h.call('GET', '/api/v1/trades')).data.trades;
    assert.equal(trades.length, 3);
    const api = trades.find((t) => t.id === 'binance_1');
    assert.equal(api.date, '2026-09-01T20:30', 'hora UTC antigua → hora de Lima correcta');
    const man = trades.find((t) => t.id === 'manual_9');
    assert.equal(man.date, '2026-09-01T21:00', 'hora manual antigua ya era de Lima');
    const q = (await h.call('GET', '/api/v1/import/quarantine')).data.rows;
    assert.equal(q.length, 2);
    assert.ok(q.some((x) => /duplicado/.test(x.reasons[0])));
    assert.ok(!fs.existsSync(path.join(dir, 'credentials.json')), 'credenciales en texto plano eliminadas');
    const ex = (await h.call('GET', '/api/v1/exchanges')).data.exchanges;
    assert.equal(ex[0].apiKey, 'AAAA…CCCC');
    assert.ok(!fs.readFileSync(path.join(dir, 'credentials.enc.json'), 'utf8').includes('AAAABBBBCCCC'));
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('trades.legacy-')));
  } finally { await h.close(); }
});

test('concurrencia: 40 altas simultáneas no se pisan', async () => {
  const h = await startApp();
  try {
    await Promise.all(Array.from({ length: 40 }, (_, i) => h.call('POST', '/api/v1/trades', { type: 'compra', orderId: `c${i}`, date: '2026-09-01T10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: 1, price: 3.7, total: 3.7, status: 'completado' })));
    assert.equal((await h.call('GET', '/api/v1/trades')).data.total, 40);
    const r = await h.call('POST', '/api/v1/trades', { type: 'compra', orderId: 'c1', date: '2026-09-01T10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: 1, price: 3.7, total: 3.7, status: 'completado' });
    assert.equal(r.status, 409, 'orden repetida');
  } finally { await h.close(); }
});

test('token opcional protege /api', async () => {
  const h = await startApp({ token: 'secreto' });
  try {
    assert.equal((await h.call('GET', '/api/v1/trades')).status, 401);
    assert.equal((await h.call('GET', '/api/v1/trades', null, { 'x-arbitrack-token': 'secreto' })).status, 200);
    assert.equal((await h.call('GET', '/health')).status, 200);
  } finally { await h.close(); }
});

test('volumen: importar 20 000 filas y exportar Excel', async () => {
  const lines = ['Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Maker Fee,Taker Fee,Couterparty,Status,Created Time'];
  const t0 = Date.parse('2026-06-01T00:00:00Z');
  for (let i = 0; i < 20000; i++) {
    const buy = i % 2 === 0;
    const d = new Date(t0 + i * 90000).toISOString().replace('T', ' ').slice(0, 19);
    lines.push(`${9000000 + i},${buy ? 'Buy' : 'Sell'},USDT,PEN,${buy ? '370.00' : '372.00'},${buy ? '3.70' : '3.72'},100,${buy ? '0.05' : '0'},0,cp${i % 50},Completed,${d}`);
  }
  const h = await startApp();
  try {
    let t = Date.now();
    const r = await h.call('POST', '/api/v1/import/file', { filename: 'binance.csv', content: lines.join('\n'), commit: true });
    const importMs = Date.now() - t;
    assert.equal(r.data.result.inserted, 20000);
    t = Date.now();
    const x = await h.call('GET', '/api/v1/export/excel');
    const exportMs = Date.now() - t;
    assert.equal(x.status, 200);
    const s = (await h.call('GET', '/api/v1/stats')).data;
    // 10 000 ciclos × (99.95 × 3.72 − 370) → venta de 100 con compra neta de 99.95: queda faltante mínimo
    assert.ok(s.byPair[0].cycles >= 9999);
    console.log(`    importar 20k: ${importMs} ms · exportar: ${exportMs} ms`);
    assert.ok(importMs < 30000 && exportMs < 60000);
  } finally { await h.close(); }
});

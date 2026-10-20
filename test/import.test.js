'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseCsv, parseXlsx } = require('../src/importers/tabular');
const { analyze } = require('../src/importers/importer');

const run = (csv, opts = {}) => analyze(parseCsv(csv).rows, opts);
const tr = (a, orderId) => a.trades.find((t) => t.orderId === orderId);

const BINANCE = `Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Exchange rate,Maker Fee,Taker Fee,Couterparty,Status,Created Time
22812345678901234567,Buy,USDT,PEN,370.00,3.70,100.00,,0.10,0,juan_p2p,Completed,2026-09-01 09:00:05
22812345678901234568,Sell,USDT,PEN,"1,128.00",3.76,300.00,,0,0,maria88,Completed,2026-09-01 10:15:00
22812345678901234569,Sell,USDT,PEN,37.60,3.76,10.00,,0,0,pepe,Cancelled,2026-09-01 11:00:00
22812345678901234570,Buy,USDT,USD,100.00,1.00,100.00,,0,0,ana,Completed,2026-09-01 12:00:00`;

test('Binance: detección, comisiones maker+taker, estados, pares separados', () => {
  const a = run(BINANCE, { filename: 'P2P_Order_History.csv' });
  assert.equal(a.detection.exchange, 'Binance');
  assert.equal(a.status, 'ok');
  assert.equal(a.trades.length, 4);
  const b = tr(a, '22812345678901234567');
  assert.equal(b.side, 'buy'); assert.equal(b.fee, '0.1'); assert.equal(b.feeAsset, 'USDT');
  assert.equal(b.dateUtc, '2026-09-01T14:00:05.000Z'); assert.equal(b.date, '2026-09-01T09:00');
  assert.equal(b.counterparty, 'juan_p2p');
  assert.equal(tr(a, '22812345678901234568').total, '1128', 'separador de miles dentro de comillas');
  assert.equal(tr(a, '22812345678901234569').status, 'cancelado');
  assert.deepEqual(a.summary.byPair, { 'USDT/PEN': 3, 'USDT/USD': 1 });
  assert.equal(b.id, 'binance_22812345678901234567', 'IDs largos se conservan como texto (sin pérdida de precisión)');
});

test('Bybit: "Fiat Amount" = total fiat y "Coin Amount" = cantidad cripto (no se confunden)', () => {
  const csv = `Order No.,Type,Cryptocurrency,Fiat,Price,Coin Amount,Fiat Amount,Fee,Counterparty,Status,Time
1899742990873296896,SELL,USDT,PEN,3.75,100,375,0,cliente1,Completed,2026-09-02 08:00:00
1899742990873296897,BUY,USDT,PEN,3.70,50,185,0,cliente2,Pending,2026-09-02 08:10:00`;
  const a = run(csv, { filename: 'bybit_orders.csv' });
  assert.equal(a.detection.exchange, 'Bybit');
  const s = tr(a, '1899742990873296896');
  assert.equal(s.side, 'sell'); assert.equal(s.amount, '100'); assert.equal(s.total, '375');
  assert.equal(tr(a, '1899742990873296897').status, 'pendiente');
});

test('Bitget: tabs iniciales en N° de orden, "Amount" es fiat y "Quantity" cripto', () => {
  const csv = `Order No.,Type,Coin,Fiat,Price,Quantity,Amount,Status,Time
"\t1029222647482966017",Buy,USDT,PEN,3.71,200,742,Completed,2026-09-03 14:00:00
"\t1029222647482966018",Sell,USDT,PEN,3.78,200,756,Completed,2026-09-03 18:00:00`;
  const a = run(csv, { filename: 'bitget-p2p.csv' });
  assert.equal(a.detection.exchange, 'Bitget');
  const b = tr(a, '1029222647482966017');
  assert.ok(b, 'el tab inicial se elimina del ID');
  assert.equal(b.amount, '200'); assert.equal(b.total, '742');
});

test('OKX: exportación con ="…" de Excel y tabs', () => {
  const csv = `Order ID,Side,Crypto,Fiat,Unit price,Crypto amount,Fiat amount,Status,Created at
="\t555001",buy,USDT,PEN,3.70,10,37,Completed,2026-09-04 09:00:00
="\t555002",sell,USDT,PEN,3.80,10,38,Canceled,2026-09-04 10:00:00`;
  const a = run(csv, { filename: 'okx.csv' });
  assert.equal(a.detection.exchange, 'OKX');
  assert.ok(tr(a, '555001'));
  assert.equal(tr(a, '555002').status, 'cancelado');
});

test('El Dorado: encabezados en español, "Cantidad de FIAT", punto y coma y coma decimal', () => {
  const csv = `ID;Tipo;Criptomoneda;Moneda Fiat;Cantidad de cripto;Precio;Cantidad de FIAT;Estado;Fecha;Contraparte
ED-1;Compra;USDT;PEN;100,50;3,70;371,85;Completado;25/09/2026 21:05;Luis
ED-2;Venta;USDT;PEN;100,50;3,76;377,88;Finalizado;26/09/2026 08:00;Rosa
ED-3;Venta;USDT;PEN;1.000,00;3,76;3.760,00;Pendiente;26/09/2026 09:00;Rosa`;
  const a = run(csv, { filename: 'eldorado_export.csv' });
  assert.equal(a.detection.exchange, 'El Dorado');
  assert.equal(a.options.decimal, ',');
  assert.equal(a.options.dateOrder, 'DMY');
  const c = tr(a, 'ED-1');
  assert.equal(c.amount, '100.5'); assert.equal(c.total, '371.85'); assert.equal(c.dateUtc, '2026-09-26T02:05:00.000Z');
  assert.equal(tr(a, 'ED-3').amount, '1000');
  assert.equal(tr(a, 'ED-3').status, 'pendiente');
});

test('perfil genérico: columnas ambiguas ("Amount") exigen mapeo explícito', () => {
  const csv = `Fecha,Tipo,Exchange,Crypto,Fiat,Amount,Precio,Estado
2026-09-05 10:00,Compra,MiExchange,USDT,PEN,100,3.7,Completado`;
  let a = run(csv);
  assert.equal(a.status, 'needs_input');
  assert.ok(a.needs[0].ambiguousHeaders.includes('Amount'));
  a = run(csv, { mapping: { amount: 'Amount' } });
  assert.equal(a.status, 'ok_with_issues'); // total derivado (información) y sin ID
  assert.equal(a.trades[0].total, '370');
  assert.ok(a.trades[0].derived.includes('total = cantidad × precio'));
});

test('mapeo invertido (cantidad ↔ total) se detecta y bloquea el registro', () => {
  const csv = `Fecha,Tipo,Exchange,Crypto,Fiat,Cantidad de cripto,Precio,Total Fiat,Estado,Order ID
2026-09-05 10:00,Compra,X,USDT,PEN,370,3.7,100,Completado,1
2026-09-05 11:00,Compra,X,USDT,PEN,740,3.7,200,Completado,2
2026-09-05 12:00,Venta,X,USDT,PEN,380,3.8,100,Completado,3`;
  const a = run(csv);
  assert.equal(a.status, 'error');
  assert.match(a.blocking[0], /intercambiando/);
});

test('fechas ambiguas en todo el archivo → se pide el formato; inconsistentes → error', () => {
  const amb = `Order ID,Fecha,Tipo,Exchange,Crypto,Fiat,Cantidad de cripto,Precio,Estado
1,01/09/2026 10:00,Compra,X,USDT,PEN,1,3.7,Completado
2,02/09/2026 10:00,Venta,X,USDT,PEN,1,3.8,Completado`;
  let a = run(amb);
  assert.equal(a.rejected.length, 2);
  assert.match(a.rejected[0].reasons[0], /ambigua/);
  a = run(amb, { dateOrder: 'DMY' });
  assert.equal(a.trades[0].dateUtc, '2026-09-01T15:00:00.000Z');
  const mixed = amb.replace('02/09/2026', '13/09/2026').replace('01/09/2026', '09/25/2026');
  a = run(mixed);
  assert.equal(a.status, 'error');
});

test('filas inválidas se rechazan con motivo; el resto se procesa', () => {
  const csv = `Order ID,Fecha,Tipo,Exchange,Crypto,Fiat,Cantidad de cripto,Precio,Estado
1,2026-09-05 10:00,Compra,X,USDT,PEN,100,3.7,Completado
2,2026-09-05 10:00,Transferencia,X,USDT,PEN,100,3.7,Completado
3,fecha mala,Venta,X,USDT,PEN,100,3.8,Completado
4,2026-09-05 12:00,Venta,X,USDT,PEN,abc,3.8,Completado
,,,,,,,,`;
  const a = run(csv);
  assert.equal(a.trades.length, 1);
  assert.equal(a.rejected.length, 3);
  assert.deepEqual(a.rejected.map((r) => r.row), [3, 4, 5]);
});

test('zona horaria: encabezado "(UTC)" y zona explícita del usuario', () => {
  const csv = `Order ID,Date(UTC),Tipo,Exchange,Crypto,Fiat,Cantidad de cripto,Precio,Estado
1,2026-09-05 10:00:00,Compra,X,USDT,PEN,1,3.7,Completado`;
  assert.equal(run(csv).trades[0].dateUtc, '2026-09-05T10:00:00.000Z');
  assert.equal(run(csv, { tz: 'America/Lima' }).trades[0].dateUtc, '2026-09-05T15:00:00.000Z');
  assert.equal(run(csv.replace('Date(UTC)', 'Created Time (UTC+8)')).trades[0].dateUtc, '2026-09-05T02:00:00.000Z');
});

test('filtro por par: un archivo con varios mercados puede limitarse a USDT/PEN', () => {
  const a = run(BINANCE, { filename: 'binance.csv', onlyPairs: ['USDT/PEN'] });
  assert.equal(a.trades.length, 3);
  assert.equal(a.filtered.length, 1);
});

test('XLSX: fechas de celda y números nativos', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Orders');
  ws.addRow(['Reporte de órdenes P2P']);
  ws.addRow(['Order No.', 'Type', 'Coin', 'Fiat', 'Price', 'Quantity', 'Amount', 'Status', 'Time']);
  ws.addRow(['1029222647482966099', 'Buy', 'USDT', 'PEN', 3.7, 100, 370, 'Completed', new Date(Date.UTC(2026, 8, 6, 10, 0, 0))]);
  const buf = await wb.xlsx.writeBuffer();
  const { rows } = await parseXlsx(Buffer.from(buf));
  const a = analyze(rows, { filename: 'bitget.xlsx' });
  assert.equal(a.detection.headerRow, 2, 'salta filas de título');
  assert.equal(a.trades[0].dateUtc, '2026-09-06T15:00:00.000Z', 'hora de pared de la hoja interpretada en Lima');
  assert.equal(a.trades[0].total, '370');
});

test('CSV: BOM, CRLF, comillas escapadas y saltos de línea dentro de celdas', () => {
  const { rows, delimiter } = parseCsv('﻿a;b;c\r\n"x;1";"di""jo";"línea\nnueva"\r\n');
  assert.equal(delimiter, ';');
  assert.deepEqual(rows[1], ['x;1', 'di"jo', 'línea\nnueva']);
});

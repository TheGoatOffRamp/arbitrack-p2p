'use strict';
// Reporte Excel para conciliación contable.
// Principios: una fila = un hecho; fechas como fechas reales; importes como números (no texto);
// nunca se suman monedas distintas; totales con fórmulas verificables.
const ExcelJS = require('exceljs');
const { D, num } = require('../money');
const { toExcelDate, toLocalFull } = require('../dates');

const C = {
  ink: 'FF1E293B', sub: 'FF475569', muted: 'FF94A3B8', head: 'FF0F172A', headInk: 'FFFFFFFF', band: 'FFF8FAFC',
  line: 'FFE2E8F0', pos: 'FF047857', neg: 'FFB91C1C', warn: 'FFB45309', total: 'FFEFF6FF',
};
const FMT = {
  date: 'yyyy-mm-dd hh:mm:ss', fiat: '#,##0.00;[Red]-#,##0.00', crypto: '#,##0.00######;[Red]-#,##0.00######',
  price: '#,##0.0000##', pct: '0.000"%";[Red]-0.000"%"', int: '#,##0',
};
const border = { style: 'thin', color: { argb: C.line } };
const BORDERS = { top: border, left: border, bottom: border, right: border };
const SIDE = { buy: 'Compra', sell: 'Venta' };
const STATUS_LABEL = { completado: 'Completada', pendiente: 'Pendiente', cancelado: 'Cancelada', fallido: 'Fallida', en_disputa: 'En disputa', desconocido: 'Desconocido' };
const SOURCE = { api: 'API', csv: 'Archivo', manual: 'Manual' };
const SEV = { error: 'Error (excluida)', warning: 'Advertencia', info: 'Información' };

const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function titleBlock(ws, title, lines, width) {
  ws.mergeCells(1, 1, 1, width);
  const t = ws.getCell(1, 1);
  t.value = title; t.font = { bold: true, size: 14, color: { argb: C.ink } };
  lines.forEach((l, i) => {
    ws.mergeCells(2 + i, 1, 2 + i, width);
    const c = ws.getCell(2 + i, 1); c.value = l; c.font = { size: 9, color: { argb: C.sub } };
  });
  return 2 + lines.length + 1; // fila del encabezado
}

/**
 * Tabla con encabezado, formatos por columna, filtros y paneles fijos.
 * cols: [{ header, key, width, fmt, get(row) }]
 */
function table(ws, headerRow, cols, rows, { freeze = true, filter = true } = {}) {
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width || 14;
    const cell = ws.getCell(headerRow, i + 1);
    cell.value = c.header;
    cell.font = { bold: true, size: 10, color: { argb: C.headInk } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = BORDERS;
  });
  ws.getRow(headerRow).height = 30;
  // En hojas grandes se omite el formato decorativo por celda (bordes, bandas): el costo de escritura crece con cada estilo.
  const light = rows.length > 3000;
  rows.forEach((r, idx) => {
    const rowNo = headerRow + 1 + idx;
    cols.forEach((c, i) => {
      const cell = ws.getCell(rowNo, i + 1);
      const v = c.get(r, rowNo);
      cell.value = v === undefined ? null : v;
      if (c.fmt) cell.numFmt = FMT[c.fmt] || c.fmt;
      if (light) { if (c.font) cell.font = c.font(r); return; }
      cell.font = { size: 10, color: { argb: C.ink }, ...(c.font ? c.font(r) : {}) };
      cell.border = BORDERS;
      if (c.align) cell.alignment = { horizontal: c.align };
      if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.band } };
    });
  });
  if (freeze) ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 0 }];
  if (filter && rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow + rows.length, column: cols.length } };
  return headerRow + rows.length; // última fila de datos
}

function totalRow(ws, rowNo, label, cells) {
  const l = ws.getCell(rowNo, 1);
  l.value = label; l.font = { bold: true, size: 10 };
  for (const [col, value, fmt] of cells) {
    const c = ws.getCell(rowNo, col);
    c.value = value; c.numFmt = FMT[fmt] || fmt; c.font = { bold: true, size: 10 };
  }
  ws.getRow(rowNo).eachCell({ includeEmpty: false }, (c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.total } }; c.border = BORDERS; });
}

const n = (d, dp = 8) => (d === null || d === undefined ? null : num(d, dp));
const signFont = (v) => ({ color: { argb: D(v || 0).isNegative() ? C.neg : C.pos }, bold: true });

/**
 * @param {object} rep  resultado de engine.compute
 * @param {object} ctx  { trades (todas), userName, tz, fromLabel, toLabel }
 */
async function buildWorkbook(rep, ctx) {
  const tz = rep.period.tz;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ArbiTrack P2P';
  wb.created = new Date();
  const periodLabel = `${ctx.scopeLabel ? `${ctx.scopeLabel} · ` : ''}Período: ${ctx.fromLabel || 'inicio'} → ${ctx.toLabel || 'hoy'} · Horas en ${tz} (UTC${tz === 'America/Lima' ? '−05:00' : ''})`;
  const gen = `Generado: ${toLocalFull(Date.now(), tz)} · Titular: ${ctx.userName || '—'}`;

  const inPeriod = (iso) => { const ms = Date.parse(iso); return (rep.period.fromMs === null || ms >= rep.period.fromMs) && (rep.period.toMs === null || ms < rep.period.toMs); };
  const trades = ctx.trades.filter((t) => !t.deleted && inPeriod(t.dateUtc)).sort((a, b) => a.dateUtc.localeCompare(b.dateUtc) || a.id.localeCompare(b.id));
  const counted = trades.filter((t) => rep.tradeInfo.get(t.id)?.countable);
  const excluded = trades.filter((t) => !rep.tradeInfo.get(t.id)?.countable);
  const cycleById = new Map(rep.cycles.map((c) => [c.id, c]));
  const feeByTrade = new Map(rep.fees.map((f) => [f.tradeId, f]));

  // ── 1. Resumen (estado de resultados por par) ───────────────────────────
  const ws = wb.addWorksheet('Resumen', { properties: { tabColor: { argb: 'FF047857' } } });
  const pairs = rep.pairs;
  const width = Math.max(3, pairs.length + 2);
  let r = titleBlock(ws, 'ArbiTrack P2P — Resumen de resultados', [periodLabel, gen,
    'Cada columna es un mercado (par). Importes en la moneda cotizada del par; los pares NO se suman entre sí.'], width);
  ws.getColumn(1).width = 46; ws.getColumn(2).width = 12;
  pairs.forEach((p, i) => { ws.getColumn(3 + i).width = 20; });
  const hdr = ws.getRow(r);
  hdr.getCell(1).value = 'Concepto'; hdr.getCell(2).value = 'Unidad';
  pairs.forEach((p, i) => { hdr.getCell(3 + i).value = p.pair; });
  hdr.eachCell((c) => { c.font = { bold: true, color: { argb: C.headInk } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.head } }; c.alignment = { horizontal: 'center' }; c.border = BORDERS; });
  const lines = [
    ['MOVIMIENTOS DEL PERÍODO'],
    ['Compras (órdenes)', 'n', (p) => p.buys.count, 'int'],
    ['Cantidad comprada', 'cripto', (p) => n(p.buys.qty), 'crypto'],
    ['Fiat pagado en compras', 'fiat', (p) => n(p.buys.fiat, 2), 'fiat'],
    ['Precio promedio de compra', 'fiat', (p) => (p.buys.qty.gt(0) ? n(p.buys.fiat.div(p.buys.qty), 8) : null), 'price'],
    ['Ventas (órdenes)', 'n', (p) => p.sells.count, 'int'],
    ['Cantidad vendida', 'cripto', (p) => n(p.sells.qty), 'crypto'],
    ['Fiat recibido en ventas', 'fiat', (p) => n(p.sells.fiat, 2), 'fiat'],
    ['Precio promedio de venta', 'fiat', (p) => (p.sells.qty.gt(0) ? n(p.sells.fiat.div(p.sells.qty), 8) : null), 'price'],
    ['RESULTADO (FIFO)'],
    ['Ingreso reconocido por ventas', 'fiat', (p) => n(p.proceeds, 2), 'fiat'],
    ['(−) Costo de lo vendido', 'fiat', (p) => n(p.costOfSales, 2), 'fiat'],
    ['= Ganancia bruta', 'fiat', (p) => n(p.gross, 2), 'fiat', true],
    ['(−) Comisiones', 'fiat', (p) => n(p.fees, 2), 'fiat'],
    ['(−) Otros costos', 'fiat', (p) => n(p.otherCosts, 2), 'fiat'],
    ['= Ganancia neta', 'fiat', (p) => n(p.net, 2), 'fiat', true],
    ['Margen neto sobre costo', '%', (p) => (p.costOfSales.gt(0) ? n(p.net.div(p.costOfSales).times(100), 4) : null), 'pct'],
    ['Ciclos cerrados', 'n', (p) => p.cycles, 'int'],
    ['INVENTARIO (valorizado a costo)'],
    ['Inventario inicial — cantidad', 'cripto', (p) => n(p.openingInventory.qty), 'crypto'],
    ['Inventario inicial — costo', 'fiat', (p) => n(p.openingInventory.cost, 2), 'fiat'],
    ['Inventario final — cantidad', 'cripto', (p) => n(p.closingInventory.qty), 'crypto'],
    ['Inventario final — costo', 'fiat', (p) => n(p.closingInventory.cost, 2), 'fiat'],
    ['Inventario final — costo promedio', 'fiat', (p) => n(p.closingInventory.avgCost, 8), 'price'],
    ['CONTROLES'],
    ['Ventas sin compra registrada (no reconocidas)', 'fiat', (p) => n(p.unrecognizedProceeds, 2), 'fiat'],
    ['Flujo neto de caja del período', 'fiat', (p) => n(p.reconciliation.cashNet, 2), 'fiat'],
    ['(+) Variación de inventario a costo', 'fiat', (p) => n(p.reconciliation.deltaInventory, 2), 'fiat'],
    ['Diferencia vs. ganancia neta (debe ser 0)', 'fiat', (p) => n(p.reconciliation.difference, 8), 'fiat'],
  ];
  for (const [label, unit, fn, fmt, strong] of lines) {
    r++;
    const row = ws.getRow(r);
    row.getCell(1).value = label;
    if (!fn) {
      row.getCell(1).font = { bold: true, size: 10, color: { argb: C.sub } };
      continue;
    }
    row.getCell(2).value = unit; row.getCell(2).font = { size: 9, color: { argb: C.muted } };
    row.getCell(1).font = { size: 10, bold: !!strong };
    pairs.forEach((p, i) => {
      const c = row.getCell(3 + i);
      c.value = fn(p); c.numFmt = FMT[fmt]; c.border = BORDERS;
      c.font = strong ? { size: 11, ...signFont(fn(p)) } : { size: 10 };
      if (strong) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.total } };
    });
  }
  r += 2;
  const sevCount = (s) => rep.issues.filter((i) => i.severity === s).length;
  const facts = [
    ['Operaciones del período', trades.length],
    ['Contabilizadas (completadas y válidas)', counted.length],
    ['Excluidas (pendientes, canceladas, fallidas, en disputa o con error)', excluded.length],
    ['Incidencias: errores / advertencias / información', `${sevCount('error')} / ${sevCount('warning')} / ${sevCount('info')}`],
  ];
  for (const [k, v] of facts) { ws.getCell(r, 1).value = k; ws.getCell(r, 3).value = v; ws.getCell(r, 1).font = { size: 10, color: { argb: C.sub } }; r++; }
  if (!pairs.length) { ws.getCell(r + 1, 1).value = 'No hay operaciones completadas en el período.'; }
  ws.views = [{ state: 'frozen', ySplit: 5, xSplit: 2 }];

  // ── 2. Operaciones contabilizadas ────────────────────────────────────────
  const wo = wb.addWorksheet('Operaciones', { properties: { tabColor: { argb: 'FF2563EB' } } });
  let h = titleBlock(wo, 'Operaciones contabilizadas', [periodLabel, 'Solo operaciones completadas y sin errores. Las demás están en la hoja "Excluidas". Totales por par en "Por moneda".'], 20);
  const opCols = [
    { header: `Fecha y hora (${tz})`, width: 20, fmt: 'date', get: (t) => toExcelDate(Date.parse(t.dateUtc), tz) },
    { header: 'Exchange', width: 11, get: (t) => t.exchange },
    { header: 'N° de orden', width: 24, get: (t) => t.orderId || '(sin ID)' },
    { header: 'Contraparte', width: 18, get: (t) => t.counterparty || '' },
    { header: 'Tipo', width: 9, align: 'center', get: (t) => SIDE[t.side], font: (t) => ({ bold: true, color: { argb: t.side === 'buy' ? 'FF1D4ED8' : C.pos } }) },
    { header: 'Par', width: 11, get: (t) => t.pair },
    { header: 'Cantidad (cripto)', width: 16, fmt: 'crypto', get: (t) => n(t.amount) },
    { header: 'Precio', width: 12, fmt: 'price', get: (t) => n(t.price) },
    { header: 'Total (fiat)', width: 15, fmt: 'fiat', get: (t) => n(t.total, 2) },
    { header: 'Comisión', width: 12, fmt: 'crypto', get: (t) => n(t.fee) },
    { header: 'Moneda comisión', width: 10, get: (t) => (D(t.fee).gt(0) ? t.feeAsset : '') },
    { header: 'Comisión valorizada (fiat)', width: 14, fmt: 'fiat', get: (t) => (feeByTrade.get(t.id) ? n(feeByTrade.get(t.id).feeValue, 2) : 0) },
    { header: 'Estado', width: 11, get: (t) => STATUS_LABEL[t.status] },
    { header: 'Ciclo', width: 26, get: (t) => { const i = rep.tradeInfo.get(t.id); return t.side === 'sell' ? (i.cycleRef || '') : [...new Set(i.cycleRefs || [])].join(', ') || (i.openQty ? 'en inventario' : ''); } },
    { header: 'Ganancia bruta del ciclo', width: 14, fmt: 'fiat', get: (t) => { const c = t.side === 'sell' && cycleById.get(rep.tradeInfo.get(t.id).cycleRef); return c && c.kind === 'automatico' ? n(c.gross, 2) : null; } },
    { header: 'Ganancia neta del ciclo', width: 14, fmt: 'fiat', get: (t) => { const c = t.side === 'sell' && cycleById.get(rep.tradeInfo.get(t.id).cycleRef); return c && c.kind === 'automatico' ? n(c.net, 2) : null; } },
    { header: 'Método de pago', width: 16, get: (t) => t.payMethod || '' },
    { header: 'Fuente', width: 9, get: (t) => SOURCE[t.source] || t.source },
    { header: 'Archivo / fila', width: 22, get: (t) => (t.sourceRef?.file ? `${t.sourceRef.file} · fila ${t.sourceRef.row}` : '') },
    { header: 'ID interno', width: 26, get: (t) => t.id },
  ];
  const opLast = table(wo, h, opCols, counted);
  const OPS = { first: h + 1, last: Math.max(opLast, h + 1) };
  const rng = (col) => `Operaciones!$${colLetter(col)}$${OPS.first}:$${colLetter(col)}$${OPS.last}`;

  // ── 3. Ciclos ────────────────────────────────────────────────────────────
  const wc = wb.addWorksheet('Ciclos', { properties: { tabColor: { argb: 'FF7C3AED' } } });
  h = titleBlock(wc, 'Ciclos de arbitraje', [periodLabel,
    'Ciclo automático = una venta y los lotes de compra que consume por FIFO dentro del mismo par. Ciclo manual = grupo definido por el usuario.',
    'Detalle unidad por unidad en "Trazabilidad FIFO".'], 21);
  const cyc = rep.cycles;
  const running = []; { const acc = new Map(); for (const c of cyc) { const v = (acc.get(c.pair) || D(0)).plus(n(c.net, 2)); acc.set(c.pair, v); running.push(v); } }
  const cycCols = [
    { header: 'Ciclo', width: 28, get: (c) => c.name ? `${c.name} (${c.id})` : c.id },
    { header: 'Tipo', width: 11, get: (c) => c.kind },
    { header: 'Par', width: 11, get: (c) => c.pair },
    { header: 'Estado', width: 11, get: (c) => c.status, font: (c) => ({ color: { argb: c.status === 'completo' ? C.pos : C.warn }, bold: true }) },
    { header: 'Apertura', width: 20, fmt: 'date', get: (c) => toExcelDate(Date.parse(c.openedAt), tz) },
    { header: 'Cierre', width: 20, fmt: 'date', get: (c) => toExcelDate(Date.parse(c.closedAt), tz) },
    { header: 'Exchange(s) de compra', width: 18, get: (c) => c.buyExchanges.join(', ') },
    { header: 'Exchange de venta', width: 14, get: (c) => c.sellExchange },
    { header: 'Cantidad', width: 15, fmt: 'crypto', get: (c) => n(c.qty) },
    { header: 'Precio prom. compra', width: 13, fmt: 'price', get: (c) => (D(c.qty).gt(0) ? n(D(c.costBasis).div(c.qty)) : null) },
    { header: 'Precio venta', width: 12, fmt: 'price', get: (c) => (c.sellPrice ? n(c.sellPrice) : null) },
    { header: 'Ingreso', width: 14, fmt: 'fiat', get: (c) => n(c.proceeds, 2) },
    { header: 'Costo FIFO', width: 14, fmt: 'fiat', get: (c) => n(c.costBasis, 2) },
    { header: 'Ganancia bruta', width: 14, fmt: 'fiat', get: (c) => n(c.gross, 2) },
    { header: 'Comisiones', width: 12, fmt: 'fiat', get: (c) => n(c.fees, 2) },
    { header: 'Otros costos', width: 12, fmt: 'fiat', get: (c) => n(c.otherCosts, 2) },
    { header: 'Ganancia neta', width: 14, fmt: 'fiat', get: (c) => n(c.net, 2), font: (c) => signFont(c.net) },
    { header: 'Margen neto %', width: 11, fmt: 'pct', get: (c) => (c.marginPct === null ? null : n(c.marginPct, 4)) },
    // Resultado acumulado por par, con fórmula verificable
    { header: 'Neta acumulada del par', width: 15, fmt: 'fiat', get: (c, row) => ({ formula: `SUMIFS($Q$${h + 1}:Q${row},$C$${h + 1}:C${row},C${row})`, result: n(running[row - h - 1], 2) }) },
    { header: 'Compras (IDs)', width: 30, get: (c) => c.buyTradeIds.join(', ') },
    { header: 'Ventas (IDs)', width: 26, get: (c) => c.sellTradeIds.join(', ') },
  ];
  table(wc, h, cycCols, cyc);

  // ── 4. Trazabilidad FIFO ─────────────────────────────────────────────────
  const wf = wb.addWorksheet('Trazabilidad FIFO', { properties: { tabColor: { argb: 'FF64748B' } } });
  h = titleBlock(wf, 'Trazabilidad FIFO: qué compra respalda cada venta', [periodLabel, 'Costo asignado = cantidad × precio de compra. Comisión de compra asignada en proporción a la cantidad consumida del lote.'], 12);
  table(wf, h, [
    { header: 'Ciclo', width: 28, get: (a) => a.cycleId },
    { header: 'Par', width: 11, get: (a) => a.pair },
    { header: 'Uso', width: 16, get: (a) => a.purpose },
    { header: 'Venta (ID)', width: 26, get: (a) => a.sellId },
    { header: 'Fecha venta', width: 20, fmt: 'date', get: (a) => toExcelDate(Date.parse(a.sellDate), tz) },
    { header: 'Exchange venta', width: 12, get: (a) => a.sellExchange },
    { header: 'Compra (ID)', width: 26, get: (a) => a.buyId },
    { header: 'Fecha compra', width: 20, fmt: 'date', get: (a) => toExcelDate(Date.parse(a.buyDate), tz) },
    { header: 'Exchange compra', width: 12, get: (a) => a.buyExchange },
    { header: 'Cantidad asignada', width: 15, fmt: 'crypto', get: (a) => n(a.qty) },
    { header: 'Precio compra', width: 13, fmt: 'price', get: (a) => n(a.buyPrice) },
    { header: 'Costo asignado', width: 14, fmt: 'fiat', get: (a) => n(a.cost, 8) },
    { header: 'Comisión compra asignada', width: 14, fmt: 'fiat', get: (a) => n(a.buyFee, 8) },
  ], rep.allocations);

  // ── 5. Por moneda (totales con fórmulas sobre la hoja Operaciones) ─────────
  const wm = wb.addWorksheet('Por moneda', { properties: { tabColor: { argb: 'FF0EA5E9' } } });
  h = titleBlock(wm, 'Totales por par / moneda', [periodLabel, 'Montos de compra y venta calculados con SUMIFS sobre la hoja Operaciones (verificables). Resultado según FIFO.'], 12);
  table(wm, h, [
    { header: 'Par', width: 12, get: (p) => p.pair },
    { header: 'Moneda cripto', width: 10, get: (p) => p.crypto },
    { header: 'Moneda fiat', width: 10, get: (p) => p.fiat },
    { header: 'Cantidad comprada', width: 16, fmt: 'crypto', get: (p) => ({ formula: `SUMIFS(${rng(7)},${rng(6)},"${p.pair}",${rng(5)},"Compra")`, result: n(p.buys.qty) }) },
    { header: 'Fiat pagado', width: 16, fmt: 'fiat', get: (p) => ({ formula: `SUMIFS(${rng(9)},${rng(6)},"${p.pair}",${rng(5)},"Compra")`, result: n(p.buys.fiat, 2) }) },
    { header: 'Cantidad vendida', width: 16, fmt: 'crypto', get: (p) => ({ formula: `SUMIFS(${rng(7)},${rng(6)},"${p.pair}",${rng(5)},"Venta")`, result: n(p.sells.qty) }) },
    { header: 'Fiat recibido', width: 16, fmt: 'fiat', get: (p) => ({ formula: `SUMIFS(${rng(9)},${rng(6)},"${p.pair}",${rng(5)},"Venta")`, result: n(p.sells.fiat, 2) }) },
    { header: 'Comisiones (fiat)', width: 14, fmt: 'fiat', get: (p) => ({ formula: `SUMIFS(${rng(12)},${rng(6)},"${p.pair}")`, result: n(rep.fees.filter((f) => f.pair === p.pair).reduce((a, f) => a.plus(f.feeValue), D(0)), 2) }) },
    { header: 'Ganancia bruta', width: 14, fmt: 'fiat', get: (p) => n(p.gross, 2) },
    { header: 'Otros costos', width: 12, fmt: 'fiat', get: (p) => n(p.otherCosts, 2) },
    { header: 'Ganancia neta', width: 14, fmt: 'fiat', get: (p) => n(p.net, 2), font: (p) => signFont(p.net) },
    { header: 'Inventario final', width: 16, fmt: 'crypto', get: (p) => n(p.closingInventory.qty) },
  ], pairs);

  // ── 6. Por exchange ──────────────────────────────────────────────────────
  const we = wb.addWorksheet('Por exchange', { properties: { tabColor: { argb: 'FF14B8A6' } } });
  h = titleBlock(we, 'Resultados por exchange', [periodLabel, 'El resultado de cada ciclo se atribuye al exchange donde se cerró la venta.'], 12);
  table(we, h, [
    { header: 'Par', width: 11, get: (e) => e.pair },
    { header: 'Exchange', width: 12, get: (e) => e.exchange },
    { header: 'Compras', width: 9, fmt: 'int', get: (e) => e.buys },
    { header: 'Cantidad comprada', width: 16, fmt: 'crypto', get: (e) => n(e.buyQty) },
    { header: 'Fiat pagado', width: 15, fmt: 'fiat', get: (e) => n(e.buyFiat, 2) },
    { header: 'Ventas', width: 9, fmt: 'int', get: (e) => e.sells },
    { header: 'Cantidad vendida', width: 16, fmt: 'crypto', get: (e) => n(e.sellQty) },
    { header: 'Fiat recibido', width: 15, fmt: 'fiat', get: (e) => n(e.sellFiat, 2) },
    { header: 'Comisiones (fiat)', width: 14, fmt: 'fiat', get: (e) => n(e.fees, 2) },
    { header: 'Bruta (ciclos cerrados aquí)', width: 16, fmt: 'fiat', get: (e) => n(e.gross, 2) },
    { header: 'Neta (ciclos cerrados aquí)', width: 16, fmt: 'fiat', get: (e) => n(e.net, 2), font: (e) => signFont(e.net) },
  ], rep.byExchange);

  // ── 7. Por período ───────────────────────────────────────────────────────
  const wp = wb.addWorksheet('Por período', { properties: { tabColor: { argb: 'FFF59E0B' } } });
  h = titleBlock(wp, 'Resultados mensuales', [periodLabel, `Mes según la fecha de cierre del ciclo en ${tz}.`], 9);
  table(wp, h, [
    { header: 'Par', width: 11, get: (m) => m.pair },
    { header: 'Mes', width: 10, get: (m) => m.month },
    { header: 'Ciclos', width: 8, fmt: 'int', get: (m) => m.cycles },
    { header: 'Ingreso', width: 15, fmt: 'fiat', get: (m) => n(m.proceeds, 2) },
    { header: 'Costo FIFO', width: 15, fmt: 'fiat', get: (m) => n(m.costBasis, 2) },
    { header: 'Ganancia bruta', width: 14, fmt: 'fiat', get: (m) => n(m.gross, 2) },
    { header: 'Comisiones', width: 12, fmt: 'fiat', get: (m) => n(m.fees, 2) },
    { header: 'Otros costos', width: 12, fmt: 'fiat', get: (m) => n(m.otherCosts, 2) },
    { header: 'Ganancia neta', width: 14, fmt: 'fiat', get: (m) => n(m.net, 2), font: (m) => signFont(m.net) },
  ], rep.byMonth);

  // ── 8. Comisiones ────────────────────────────────────────────────────────
  const wk = wb.addWorksheet('Comisiones', { properties: { tabColor: { argb: 'FFEF4444' } } });
  h = titleBlock(wk, 'Comisiones pagadas', [periodLabel, 'Comisión en cripto de una compra: valorizada al precio de esa compra. De una venta: al costo FIFO de las unidades entregadas.'], 9);
  const feeLast = table(wk, h, [
    { header: `Fecha (${tz})`, width: 20, fmt: 'date', get: (f) => toExcelDate(Date.parse(f.dateUtc), tz) },
    { header: 'Exchange', width: 11, get: (f) => f.exchange },
    { header: 'N° de orden', width: 24, get: (f) => f.orderId || '(sin ID)' },
    { header: 'Par', width: 11, get: (f) => f.pair },
    { header: 'Tipo', width: 9, get: (f) => SIDE[f.side] },
    { header: 'Comisión', width: 13, fmt: 'crypto', get: (f) => n(f.fee) },
    { header: 'Moneda', width: 9, get: (f) => f.feeAsset },
    { header: 'Valor (fiat del par)', width: 14, fmt: 'fiat', get: (f) => n(f.feeValue, 8) },
    { header: 'Criterio de valorización', width: 26, get: (f) => f.valuation },
  ], rep.fees);
  if (rep.fees.length) {
    let tr = feeLast + 2;
    for (const p of pairs) {
      totalRow(wk, tr, `Total ${p.pair} (${p.fiat})`, [[8, { formula: `SUMIFS(H${h + 1}:H${feeLast},D${h + 1}:D${feeLast},"${p.pair}")`, result: n(rep.fees.filter((f) => f.pair === p.pair).reduce((a, f) => a.plus(f.feeValue), D(0)), 8) }, 'fiat']]);
      tr++;
    }
  }

  // ── 9. Otros costos ──────────────────────────────────────────────────────
  const wx = wb.addWorksheet('Otros costos');
  h = titleBlock(wx, 'Otros costos (red, bancos, transferencias)', [periodLabel, 'Costos en cripto valorizados al costo FIFO de las unidades consumidas.'], 9);
  table(wx, h, [
    { header: `Fecha (${tz})`, width: 20, fmt: 'date', get: (c) => toExcelDate(Date.parse(c.dateUtc), tz) },
    { header: 'Par', width: 11, get: (c) => c.pair },
    { header: 'Descripción', width: 30, get: (c) => c.description },
    { header: 'Exchange', width: 11, get: (c) => c.exchange || '' },
    { header: 'Monto', width: 13, fmt: 'crypto', get: (c) => n(c.amount) },
    { header: 'Moneda', width: 9, get: (c) => c.asset },
    { header: 'Valor (fiat del par)', width: 14, fmt: 'fiat', get: (c) => n(c.value, 8) },
    { header: 'Ciclo', width: 20, get: (c) => c.cycleId || '' },
    { header: 'Nota', width: 30, get: (c) => c.note || '' },
  ], rep.costs);

  // ── 10. Excluidas ────────────────────────────────────────────────────────
  const wz = wb.addWorksheet('Excluidas', { properties: { tabColor: { argb: 'FF94A3B8' } } });
  h = titleBlock(wz, 'Operaciones NO contabilizadas', [periodLabel, 'No afectan resultados, saldos ni totales. Se listan para conciliación con el exchange.'], 12);
  table(wz, h, [
    { header: `Fecha (${tz})`, width: 20, fmt: 'date', get: (t) => toExcelDate(Date.parse(t.dateUtc), tz) },
    { header: 'Exchange', width: 11, get: (t) => t.exchange },
    { header: 'N° de orden', width: 24, get: (t) => t.orderId || '(sin ID)' },
    { header: 'Contraparte', width: 18, get: (t) => t.counterparty || '' },
    { header: 'Tipo', width: 9, get: (t) => SIDE[t.side] },
    { header: 'Par', width: 11, get: (t) => t.pair },
    { header: 'Cantidad', width: 15, fmt: 'crypto', get: (t) => n(t.amount) },
    { header: 'Precio', width: 12, fmt: 'price', get: (t) => n(t.price) },
    { header: 'Total', width: 14, fmt: 'fiat', get: (t) => n(t.total, 2) },
    { header: 'Estado', width: 12, get: (t) => STATUS_LABEL[t.status] },
    { header: 'Estado original', width: 16, get: (t) => t.statusRaw || '' },
    { header: 'Motivo de exclusión', width: 44, get: (t) => rep.tradeInfo.get(t.id)?.excluded || '' },
  ], excluded);

  // ── 11. Incidencias ──────────────────────────────────────────────────────
  const wi = wb.addWorksheet('Incidencias', { properties: { tabColor: { argb: 'FFB45309' } } });
  h = titleBlock(wi, 'Incidencias detectadas', [periodLabel, 'Nada se corrige en silencio: cada inconsistencia queda listada con su motivo.'], 8);
  const sevOrder = { error: 0, warning: 1, info: 2 };
  const iss = rep.issues.filter((i) => !i.dateUtc || inPeriod(i.dateUtc))
    .sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || String(a.dateUtc).localeCompare(String(b.dateUtc)));
  table(wi, h, [
    { header: 'Severidad', width: 16, get: (i) => SEV[i.severity], font: (i) => ({ bold: true, color: { argb: i.severity === 'error' ? C.neg : i.severity === 'warning' ? C.warn : C.sub } }) },
    { header: 'Código', width: 24, get: (i) => i.code },
    { header: `Fecha (${tz})`, width: 20, fmt: 'date', get: (i) => (i.dateUtc ? toExcelDate(Date.parse(i.dateUtc), tz) : null) },
    { header: 'Par', width: 11, get: (i) => i.pair || '' },
    { header: 'Exchange', width: 11, get: (i) => i.exchange || '' },
    { header: 'N° de orden', width: 24, get: (i) => i.orderId || '' },
    { header: 'Referencia', width: 26, get: (i) => i.tradeId || i.costId || i.cycleId || '' },
    { header: 'Detalle', width: 80, get: (i) => i.message },
  ], iss);

  // ── 12. Metodología ──────────────────────────────────────────────────────
  const wd = wb.addWorksheet('Metodología');
  wd.getColumn(1).width = 120;
  const notes = [
    'METODOLOGÍA DE CÁLCULO — ArbiTrack P2P',
    '',
    '1. Solo se contabilizan operaciones con estado "Completada" y sin errores de consistencia. Pendientes, canceladas, fallidas y en disputa no afectan resultados ni saldos.',
    '2. Cada par (p. ej. USDT/PEN, USDT/USD, BTC/PEN) se calcula por separado con su propio inventario. No se suman monedas distintas ni se convierten sin una tasa explícita.',
    '3. Costo de lo vendido: método FIFO (primeras entradas, primeras salidas) por par, a través de todos los exchanges. Las transferencias entre exchanges no generan resultado; sus comisiones se registran como "Otros costos".',
    '4. Ganancia bruta = ingreso de la venta − costo FIFO. Comisiones = comisión de compra asignada + comisión de venta. Ganancia neta = bruta − comisiones − otros costos.',
    '5. Comisión en cripto de una compra: reduce la cantidad recibida y se valoriza al precio de esa compra. Comisión en cripto de una venta: consume inventario y se valoriza a su costo FIFO. Comisión en fiat: su importe.',
    '6. Si se vende más cripto de la que se compró (ventas sin compra registrada), la parte sin costo conocido NO se reconoce como ganancia y se reporta en Controles e Incidencias.',
    '7. Resultados de un período: el inventario acumulado antes del período se arrastra como inventario inicial (a costo). El resultado se reconoce en la fecha de la venta.',
    '8. Conciliación: flujo neto de caja del período + variación de inventario a costo = ganancia neta. La diferencia debe ser 0 en cada par.',
    `9. Fechas: se almacenan en UTC y se muestran en ${tz}. Los archivos importados sin zona horaria se interpretaron en la zona indicada al importar.`,
    '10. Importes almacenados con precisión decimal exacta; en esta hoja se muestran redondeados según el formato de celda (el valor completo está en la celda).',
  ];
  notes.forEach((t, i) => { const c = wd.getCell(i + 1, 1); c.value = t; c.alignment = { wrapText: true, vertical: 'top' }; c.font = i === 0 ? { bold: true, size: 13 } : { size: 10 }; });

  // Impresión / PDF: horizontal y ajustado al ancho de una página
  for (const sheet of wb.worksheets) {
    sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
    sheet.headerFooter = { oddFooter: `ArbiTrack P2P · ${sheet.name} · Página &P de &N` };
  }

  return wb;
}

module.exports = { buildWorkbook };

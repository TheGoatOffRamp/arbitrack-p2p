'use strict';
// Reporte PDF para el contador: resumen de una a pocas páginas, listo para imprimir o adjuntar.
// El detalle operación por operación está en el Excel; aquí van los resultados y los controles.
const PDFDocument = require('pdfkit');
const { D } = require('../money');
const { toLocalFull } = require('../dates');

const INK = '#1e293b', SUB = '#475569', MUTED = '#94a3b8', LINE = '#e2e8f0', HEAD = '#0f172a', BAND = '#f8fafc', POS = '#047857', NEG = '#b91c1c', WARN = '#b45309';
const SYMBOL = { PEN: 'S/', USD: 'US$' };
const M = 40; // margen

/** 1234.5 → "1,234.50" sin pasar por float. */
function fmt(v, dp = 2) {
  if (v === null || v === undefined) return '';
  const s = D(v).toFixed(dp).replace(/^-(0\.?0*)$/, '$1'); // sin "-0.00"
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  return `${neg ? '-' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}
const money = (v, cur) => `${SYMBOL[cur] || cur} ${fmt(v, 2)}`;
const qty = (v) => fmt(D(v).toDecimalPlaces(8), Math.min(8, Math.max(2, D(v).toDecimalPlaces(8).decimalPlaces())));
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[+m - 1]} ${y}`; };

/**
 * @param {object} rep  resultado de engine.compute
 * @param {object} ctx  { trades (todas), userName, fromLabel, toLabel }
 * @returns {Promise<Buffer>}
 */
function buildPdf(rep, ctx) {
  const tz = rep.period.tz;
  const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M + 10, left: M, right: M }, bufferPages: true,
    info: { Title: 'ArbiTrack P2P - Reporte para el contador', Author: ctx.userName || 'ArbiTrack P2P', Creator: 'ArbiTrack P2P' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const W = doc.page.width - 2 * M;
  const bottom = () => doc.page.height - M - 20;

  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const h2 = (text, keep = 60) => {
    ensure(keep);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor(INK).text(text, M, doc.y);
    doc.moveTo(M, doc.y + 2).lineTo(M + W, doc.y + 2).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.6);
  };
  const para = (text, opts = {}) => doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 9).fillColor(opts.color || SUB).text(text, M, doc.y, { width: W, ...opts });

  /** cols: [{ header, width (fracción), align, get(row) → texto, color?(row) }] */
  function table(cols, rows, { boldRow } = {}) {
    const widths = cols.map((c) => c.width * W);
    const pad = 4, size = 8;
    const rowHeight = (cells, bold) => Math.max(...cells.map((t, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(String(t), { width: widths[i] - 2 * pad }))) + 2 * pad;
    const header = () => {
      const hh = rowHeight(cols.map((c) => c.header), true);
      ensure(hh + 20);
      let x = M; const y = doc.y;
      doc.rect(M, y, W, hh).fill(HEAD);
      cols.forEach((c, i) => {
        doc.font('Helvetica-Bold').fontSize(size).fillColor('#ffffff').text(c.header, x + pad, y + pad, { width: widths[i] - 2 * pad, align: c.align || 'left' });
        x += widths[i];
      });
      doc.y = y + hh;
    };
    header();
    rows.forEach((r, idx) => {
      const bold = boldRow ? boldRow(r) : false;
      const cells = cols.map((c) => c.get(r) ?? '');
      const rh = rowHeight(cells, bold);
      if (doc.y + rh > bottom()) { doc.addPage(); header(); }
      const y = doc.y;
      if (idx % 2 === 1) doc.rect(M, y, W, rh).fill(BAND);
      let x = M;
      cols.forEach((c, i) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(c.color ? c.color(r) || INK : INK)
          .text(String(cells[i]), x + pad, y + pad, { width: widths[i] - 2 * pad, align: c.align || 'left' });
        x += widths[i];
      });
      doc.moveTo(M, y + rh).lineTo(M + W, y + rh).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.y = y + rh;
    });
    doc.x = M;
    doc.moveDown(0.5);
  }
  const sign = (v) => (D(v || 0).isNegative() ? NEG : POS);

  const inPeriod = (iso) => { const ms = Date.parse(iso); return (rep.period.fromMs === null || ms >= rep.period.fromMs) && (rep.period.toMs === null || ms < rep.period.toMs); };
  const trades = ctx.trades.filter((t) => !t.deleted && inPeriod(t.dateUtc));
  const counted = trades.filter((t) => rep.tradeInfo.get(t.id)?.countable).length;
  const errors = rep.issues.filter((i) => i.severity === 'error').length;
  const warnings = rep.issues.filter((i) => i.severity === 'warning').length;

  // ── Encabezado ──
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text('Reporte de resultados de arbitraje P2P', M, M);
  doc.moveDown(0.2).font('Helvetica').fontSize(10).fillColor(SUB).text('Preparado para el contador · ArbiTrack P2P');
  doc.moveDown(0.8);
  const meta = [
    ['Titular', ctx.userName || '-'],
    ...(ctx.userEmail ? [['Email', ctx.userEmail]] : []),
    ['Período', `${ctx.fromLabel || 'desde el inicio'}  al  ${ctx.toLabel || 'hoy'}`],
    ...(ctx.scopeLabel ? [['Alcance', ctx.scopeLabel]] : []),
    ['Zona horaria', `${tz}${tz === 'America/Lima' ? ' (UTC-05:00)' : ''}`],
    ['Generado', toLocalFull(Date.now(), tz)],
  ];
  for (const [k, v] of meta) {
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(SUB).text(k, M, y, { width: 90 });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(v, M + 90, y, { width: W - 90 });
  }

  if (errors) {
    doc.moveDown(0.8);
    const y = doc.y;
    const msg = `Atención: hay ${errors} incidencia(s) de tipo error. Las operaciones afectadas NO se incluyeron en los resultados. Revíselas en la sección Incidencias de ArbiTrack o en la hoja "Incidencias" del Excel antes de declarar.`;
    const hh = doc.font('Helvetica-Bold').fontSize(9).heightOfString(msg, { width: W - 16 }) + 12;
    doc.rect(M, y, W, hh).fill('#fef3c7');
    doc.fillColor(WARN).text(msg, M + 8, y + 6, { width: W - 16 });
    doc.y = y + hh;
  }

  // ── Resultado por mercado ──
  h2('1. Resultado por mercado (método FIFO)');
  para('Cada par se calcula por separado, en su propia moneda. Los importes de pares con distinta moneda no se suman entre sí.');
  doc.moveDown(0.4);
  if (!rep.pairs.length) para('No hay operaciones completadas en el período.', { bold: true, color: INK });
  for (let i = 0; i < rep.pairs.length; i += 3) {
    const group = rep.pairs.slice(i, i + 3);
    const lines = [
      ['Compras (órdenes)', (p) => String(p.buys.count)],
      ['Cantidad comprada', (p) => `${qty(p.buys.qty)} ${p.crypto}`],
      ['Pagado en compras', (p) => money(p.buys.fiat, p.fiat)],
      ['Ventas (órdenes)', (p) => String(p.sells.count)],
      ['Cantidad vendida', (p) => `${qty(p.sells.qty)} ${p.crypto}`],
      ['Recibido en ventas', (p) => money(p.sells.fiat, p.fiat)],
      ['Ingreso reconocido por ventas', (p) => money(p.proceeds, p.fiat)],
      ['(-) Costo de lo vendido (FIFO)', (p) => money(p.costOfSales, p.fiat)],
      ['= Ganancia bruta', (p) => money(p.gross, p.fiat), true],
      ['(-) Comisiones', (p) => money(p.fees, p.fiat)],
      ['(-) Otros costos', (p) => money(p.otherCosts, p.fiat)],
      ['= Ganancia neta', (p) => money(p.net, p.fiat), true, (p) => sign(p.net)],
      ['Ciclos cerrados', (p) => String(p.cycles)],
      ['Inventario final (cantidad)', (p) => `${qty(p.closingInventory.qty)} ${p.crypto}`],
      ['Inventario final (a costo)', (p) => money(p.closingInventory.cost, p.fiat)],
      ['Ventas sin compra registrada (no reconocidas)', (p) => money(p.unrecognizedProceeds, p.fiat)],
      ['Control de conciliación (debe ser 0)', (p) => fmt(p.reconciliation.difference, 2)],
    ];
    const conceptW = 0.4;
    table([
      { header: 'Concepto', width: conceptW, get: (l) => l[0] },
      ...group.map((p, k) => ({ header: p.pair, width: (1 - conceptW) / group.length, align: 'right', get: (l) => l[1](p), color: (l) => (l[3] ? l[3](group[k]) : null) })),
    ], lines, { boldRow: (l) => !!l[2] });
  }

  // ── Por mes ──
  if (rep.byMonth.length) {
    h2('2. Resultado por mes');
    para('El resultado se reconoce en el mes en que se cierra la venta.');
    doc.moveDown(0.4);
    const cur = (m) => rep.pairs.find((p) => p.pair === m.pair)?.fiat || m.pair.split('/')[1];
    table([
      { header: 'Par', width: 0.10, get: (m) => m.pair },
      { header: 'Mes', width: 0.15, get: (m) => monthLabel(m.month) },
      { header: 'Ciclos', width: 0.07, align: 'right', get: (m) => String(m.cycles) },
      { header: 'Ingreso', width: 0.12, align: 'right', get: (m) => fmt(m.proceeds) },
      { header: 'Costo FIFO', width: 0.12, align: 'right', get: (m) => fmt(m.costBasis) },
      { header: 'Bruta', width: 0.10, align: 'right', get: (m) => fmt(m.gross) },
      { header: 'Comisiones', width: 0.11, align: 'right', get: (m) => fmt(m.fees) },
      { header: 'Otros costos', width: 0.10, align: 'right', get: (m) => fmt(m.otherCosts) },
      { header: 'Neta', width: 0.13, align: 'right', get: (m) => `${SYMBOL[cur(m)] || cur(m)} ${fmt(m.net)}`, color: (m) => sign(m.net) },
    ], rep.byMonth);
  }

  // ── Por exchange ──
  if (rep.byExchange.length) {
    h2('3. Movimientos por exchange');
    table([
      { header: 'Par', width: 0.11, get: (e) => e.pair },
      { header: 'Exchange', width: 0.13, get: (e) => e.exchange },
      { header: 'Compras', width: 0.09, align: 'right', get: (e) => String(e.buys) },
      { header: 'Pagado', width: 0.14, align: 'right', get: (e) => fmt(e.buyFiat) },
      { header: 'Ventas', width: 0.08, align: 'right', get: (e) => String(e.sells) },
      { header: 'Recibido', width: 0.14, align: 'right', get: (e) => fmt(e.sellFiat) },
      { header: 'Comisiones', width: 0.12, align: 'right', get: (e) => fmt(e.fees) },
      { header: 'Neta (ventas aquí)', width: 0.19, align: 'right', get: (e) => fmt(e.net), color: (e) => sign(e.net) },
    ], rep.byExchange);
  }

  // ── Calidad de datos ──
  h2('4. Calidad de los datos', 160);
  table([
    { header: 'Control', width: 0.75, get: (r) => r[0] },
    { header: 'Valor', width: 0.25, align: 'right', get: (r) => String(r[1]) },
  ], [
    ['Operaciones registradas en el período', trades.length],
    ['Contabilizadas (completadas y sin errores)', counted],
    ['Excluidas (pendientes, canceladas, fallidas, en disputa o con error)', trades.length - counted],
    ['Incidencias de tipo error', errors],
    ['Incidencias de tipo advertencia', warnings],
  ]);

  // ── Notas ──
  h2('5. Notas para el contador');
  const notes = [
    'Fuente: operaciones P2P registradas por el titular en ArbiTrack, importadas de los archivos o APIs de cada exchange o ingresadas manualmente. Cada operación conserva su número de orden y su dato original.',
    'Solo se contabilizan operaciones completadas. El costo de lo vendido se calcula por el método FIFO por par, a través de todos los exchanges.',
    'Comisión en cripto de una compra: reduce la cantidad recibida y se valoriza al precio de esa compra. Comisión en cripto de una venta: se valoriza a su costo FIFO. Comisión en moneda fiat: su importe.',
    'El inventario anterior al período se arrastra a su costo. Los importes no se convierten entre monedas.',
    'El detalle (operaciones, ciclos, trazabilidad FIFO, comisiones e incidencias) está en el Excel contable exportado para el mismo período.',
    'Este documento resume datos; la calificación tributaria (categoría de renta, tasa aplicable, tipo de cambio y obligaciones formales) corresponde al contador.',
  ];
  notes.forEach((t, i) => { ensure(30); para(`${i + 1}. ${t}`); doc.moveDown(0.3); });

  // Pie con numeración
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // el pie va dentro del margen inferior; sin esto pdfkit abriría otra página
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`ArbiTrack P2P · ${ctx.userName || ''} · Página ${i + 1} de ${range.count}`, M, doc.page.height - M, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

module.exports = { buildPdf };

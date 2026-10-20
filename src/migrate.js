'use strict';
// Migración del trades.json del backend v1.3 al libro v2.
// El formato antiguo mezclaba zonas horarias en el campo `date`:
//   - source 'api'  → hora UTC truncada sin "Z" (new Date(ts).toISOString().slice(0,16))
//   - manual/import → hora local tecleada en la webapp (Lima)
const { buildTrade } = require('./model');
const { mergeTrades, audit } = require('./ledger');

function migrateLegacy(state, oldTrades) {
  const batchId = `migracion-${Date.now()}`;
  const good = [];
  oldTrades.forEach((o, i) => {
    const isApi = o.source === 'api';
    const c = {
      exchange: o.exchange, orderId: o.orderId || null, side: o.type,
      crypto: o.crypto, fiat: o.fiat, amount: o.amount, price: o.price, total: o.total,
      fee: o.fee, feeAsset: o.fee > 0 ? (o.feeType === 'fiat' ? o.fiat : o.crypto) : null,
      status: o.status, counterparty: o.counterparty, payMethod: o.payMethod, notes: o.notes,
      raw: o,
    };
    if (isApi && typeof o.date === 'string') c.dateUtc = /Z$/.test(o.date) ? o.date : `${o.date}Z`;
    else c.date = o.date;
    const r = buildTrade(c, { decimal: '.', source: isApi ? 'api' : (o.source === 'import' ? 'csv' : 'manual'),
      sourceRef: { migratedFrom: 'trades.json', row: i, legacyId: o.id } });
    if (r.rejected) {
      state.quarantine.push({ at: new Date().toISOString(), origin: 'migracion', row: i, reasons: r.rejected.reasons, raw: o });
      return;
    }
    const t = r.trade;
    t.derived.push(isApi
      ? 'fecha migrada: el formato antiguo guardaba la hora UTC sin zona; se interpretó como UTC'
      : 'fecha migrada: se interpretó como hora de Lima (ingresada en la webapp)');
    if (o.id) t.id = o.id;
    good.push(t);
  });
  const report = mergeTrades(state, good, { batchId, origin: 'migracion' });
  for (const d of report.duplicatesInBatch) {
    state.quarantine.push({ at: new Date().toISOString(), origin: 'migracion', row: d.row,
      reasons: [`duplicado de la fila ${d.firstRow} del trades.json antiguo (misma orden/huella); no se contabiliza dos veces`],
      raw: oldTrades[d.row] });
  }
  state.batches.push({ id: batchId, kind: 'migration', at: new Date().toISOString(),
    rows: oldTrades.length, inserted: report.inserted.length, duplicates: report.duplicatesInBatch.length,
    quarantined: oldTrades.length - good.length });
  audit(state, { action: 'migration', batchId, rows: oldTrades.length });
  return report;
}

module.exports = { migrateLegacy };

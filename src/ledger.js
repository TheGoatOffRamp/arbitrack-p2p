'use strict';
// Registro de operaciones en el libro: deduplicación, actualizaciones trazables e historial.
const { D } = require('./money');

// Campos que pertenecen a la fuente (exchange). Los del usuario (notas, ciclo) nunca se pisan.
const SOURCE_FIELDS = ['side', 'type', 'crypto', 'fiat', 'pair', 'amount', 'price', 'total', 'fee', 'feeAsset', 'status',
  'statusRaw', 'dateUtc', 'date', 'counterparty', 'payMethod'];
const NUMERIC = new Set(['amount', 'price', 'total', 'fee']);

function sameValue(field, a, b) {
  if (NUMERIC.has(field)) return D(a || 0).eq(D(b || 0));
  return (a ?? null) === (b ?? null);
}

function audit(state, entry) {
  state.audit.push({ at: new Date().toISOString(), ...entry });
  if (state.audit.length > 20000) state.audit.splice(0, state.audit.length - 20000);
}

/**
 * Inserta/actualiza operaciones normalizadas.
 * @returns informe detallado (insertadas, actualizadas, sin cambios, duplicadas en lote, omitidas)
 */
function mergeTrades(state, incoming, { batchId, origin }) {
  const now = new Date().toISOString();
  const byKey = new Map(state.trades.map((t, i) => [t.dedupKey, i]));
  const usedIds = new Set(state.trades.map((t) => t.id));
  const seenInBatch = new Map();
  const report = { inserted: [], updated: [], unchanged: [], duplicatesInBatch: [], skipped: [], conflicts: [] };

  for (const t of incoming) {
    if (seenInBatch.has(t.dedupKey)) {
      const first = seenInBatch.get(t.dedupKey);
      report.duplicatesInBatch.push({ id: t.id, orderId: t.orderId, row: t.sourceRef?.row, firstRow: first.sourceRef?.row });
      continue;
    }
    seenInBatch.set(t.dedupKey, t);

    const idx = byKey.get(t.dedupKey);
    if (idx === undefined) {
      let id = t.id;
      for (let n = 2; usedIds.has(id); n++) id = `${t.id}~${n}`;
      usedIds.add(id);
      const rec = { ...t, id, batchIds: [batchId], createdAt: now, updatedAt: now, history: [], manualFields: [], deleted: false };
      state.trades.push(rec);
      byKey.set(rec.dedupKey, state.trades.length - 1);
      report.inserted.push(id);
      continue;
    }

    const ex = state.trades[idx];
    if (ex.deleted) { report.skipped.push({ id: ex.id, reason: 'la operación fue eliminada por el usuario; no se reimporta' }); continue; }
    const changes = [];
    for (const f of SOURCE_FIELDS) {
      if (sameValue(f, ex[f], t[f])) continue;
      if ((ex.manualFields || []).includes(f)) {
        report.conflicts.push({ id: ex.id, field: f, kept: ex[f], incoming: t[f], reason: 'editado manualmente; se conserva el valor del usuario' });
        continue;
      }
      changes.push({ field: f, from: ex[f], to: t[f] });
    }
    if (!ex.batchIds.includes(batchId)) ex.batchIds.push(batchId);
    if (changes.length && ex.closingId) {
      // Un ciclo cerrado no cambia: la diferencia se informa y se conserva lo congelado.
      for (const ch of changes) report.conflicts.push({ id: ex.id, field: ch.field, kept: ch.from, incoming: ch.to, reason: 'pertenece a un ciclo cerrado; reábrelo para actualizarla' });
      report.unchanged.push(ex.id);
      continue;
    }
    if (!changes.length) { report.unchanged.push(ex.id); continue; }
    for (const ch of changes) ex[ch.field] = ch.to;
    ex.raw = t.raw ?? ex.raw;
    ex.sourceRef = t.sourceRef ?? ex.sourceRef;
    ex.derived = t.derived;
    ex.updatedAt = now;
    ex.history.push({ at: now, by: origin, batchId, changes });
    report.updated.push({ id: ex.id, changes });
  }
  audit(state, { action: 'merge', batchId, origin,
    inserted: report.inserted.length, updated: report.updated.length, unchanged: report.unchanged.length,
    duplicatesInBatch: report.duplicatesInBatch.length });
  return report;
}

module.exports = { mergeTrades, audit, SOURCE_FIELDS };

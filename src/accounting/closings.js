'use strict';
// Ciclos cerrados: congelan todo lo de un par hasta una fecha de corte.
// Las operaciones y costos cerrados quedan marcados con `closingId` y ya no se pueden editar ni borrar;
// el ciclo actual solo ve lo no cerrado más el inventario que dejó el último cierre (a su costo).
const { compute, toJSONSafe } = require('./engine');
const { STATUS } = require('../model');
const { D, ZERO } = require('../money');

// Estados que aún pueden cambiar: no se congelan, siguen en el ciclo actual.
const OPEN_STATUSES = [STATUS.PENDING, STATUS.DISPUTE, STATUS.UNKNOWN];

const closingsOf = (state, pair) => (state.closings || []).filter((k) => k.pair === pair).sort((a, b) => a.seq - b.seq);

/**
 * Calcula (sin guardar) qué quedaría congelado al cerrar `pair` en `cutoffUtc`.
 * Lanza Error con un mensaje para el usuario si el cierre no es posible.
 */
function planClosing(state, { pair, cutoffUtc, tz, carry = true, now = Date.now() }) {
  if (Date.parse(cutoffUtc) > now + 60000) throw new Error('La fecha de corte no puede ser futura.');
  const prior = closingsOf(state, pair);
  const last = prior[prior.length - 1];
  if (last && cutoffUtc <= last.cutoffUtc) throw new Error(`El corte debe ser posterior al del ciclo #${last.seq} (${last.cutoffLocal}).`);

  const before = (r) => !r.deleted && r.pair === pair && !r.closingId && r.dateUtc < cutoffUtc;
  const candidates = state.trades.filter(before);
  const trades = candidates.filter((t) => !OPEN_STATUSES.includes(t.status));
  const pending = candidates.length - trades.length;
  if (!trades.some((t) => t.status === STATUS.COMPLETED)) throw new Error(`No hay operaciones completadas de ${pair} antes del corte.`);
  const costs = (state.costs || []).filter(before);

  // Un ciclo manual no puede quedar partido entre el ciclo cerrado y el actual.
  const ids = new Set(trades.map((t) => t.id));
  const costIds = new Set(costs.map((c) => c.id));
  const closedManual = new Set(trades.filter((t) => t.cycleId).map((t) => t.cycleId));
  const split = new Set([
    ...state.trades.filter((t) => !t.deleted && !t.closingId && closedManual.has(t.cycleId) && !ids.has(t.id)).map((t) => t.cycleId),
    ...(state.costs || []).filter((c) => !c.deleted && !c.closingId && closedManual.has(c.cycleId) && !costIds.has(c.id)).map((c) => c.cycleId),
  ]);
  if (split.size) {
    const names = [...split].map((id) => (state.cycles || []).find((c) => c.id === id)?.name || id);
    throw new Error(`El ciclo manual ${names.map((n) => `"${n}"`).join(', ')} tiene operaciones o costos que quedarían fuera del cierre (posteriores al corte o pendientes). Mueve la fecha de corte o quítalos del ciclo manual.`);
  }

  const id = `K-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const seq = (last?.seq || 0) + 1;
  const draft = {
    ...state,
    trades: state.trades.map((t) => (ids.has(t.id) ? { ...t, closingId: id } : t)),
    costs: (state.costs || []).map((c) => (costIds.has(c.id) ? { ...c, closingId: id } : c)),
    closings: [...(state.closings || []), { id, seq, pair, cutoffUtc, carry }],
  };
  const rep = compute(draft, { scope: id, tz });
  return {
    id, seq, tradeIds: [...ids], costIds: [...costIds], pending,
    summary: summarize(rep, pair), carryLots: carry ? rep.endLots[pair] || [] : [],
    firstUtc: trades.map((t) => t.dateUtc).sort()[0],
  };
}

/** Resumen congelado de un cierre (strings decimales, listo para JSON). */
function summarize(rep, pair) {
  const p = rep.pairs.find((x) => x.pair === pair);
  const excluded = [...rep.tradeInfo.values()].filter((i) => !i.countable).length;
  return toJSONSafe({
    buys: p?.buys || { count: 0, qty: ZERO, fiat: ZERO }, sells: p?.sells || { count: 0, qty: ZERO, fiat: ZERO },
    proceeds: p?.proceeds || ZERO, costOfSales: p?.costOfSales || ZERO, gross: p?.gross || ZERO, fees: p?.fees || ZERO,
    otherCosts: p?.otherCosts || ZERO, net: p?.net || ZERO, unrecognizedProceeds: p?.unrecognizedProceeds || ZERO,
    openingInventory: p?.openingInventory || { qty: ZERO, cost: ZERO },
    closingInventory: { qty: p?.closingInventory.qty || ZERO, cost: p?.closingInventory.cost || ZERO },
    cycles: rep.cycles.length, excluded,
    issues: { error: rep.issues.filter((i) => i.severity === 'error').length, warning: rep.issues.filter((i) => i.severity === 'warning').length },
  });
}

/** Recalcula un cierre con sus datos congelados y confirma que el resultado guardado no cambió. */
function verifyClosing(state, k, tz) {
  const now = summarize(compute(state, { scope: k.id, tz }), k.pair);
  return D(now.net).eq(D(k.summary.net)) && D(now.closingInventory.cost).eq(D(k.summary.closingInventory.cost));
}

/** Solo se puede reabrir el último cierre de cada par (los siguientes dependen de su inventario). */
function canReopen(state, k) {
  const list = closingsOf(state, k.pair);
  return list[list.length - 1]?.id === k.id;
}

module.exports = { planClosing, summarize, verifyClosing, canReopen, closingsOf, OPEN_STATUSES };

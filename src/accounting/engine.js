'use strict';
// Motor contable: FIFO por par (moneda base / moneda cotizada), sin mezclar mercados.
//
// Definiciones (todas en la moneda fiat del par):
//   Costo de lo vendido   = Σ cantidad asignada × precio de compra del lote (FIFO)
//   Ganancia bruta        = ingreso de la venta − costo de lo vendido
//   Comisiones            = comisiones de compra asignadas + comisión de venta
//                           (comisión en cripto → valorizada al costo de adquisición de esas unidades)
//   Otros costos          = registros de costo explícitos (red, bancos, transferencias)
//   Ganancia neta         = bruta − comisiones − otros costos
// Un "ciclo" automático = una venta + los lotes de compra que consume (puede cruzar exchanges).
// Un ciclo manual       = grupo de operaciones definido por el usuario, calculado con su propio inventario.
const { D, ZERO, str } = require('../money');
const { validateTrade, isCountable, STATUS } = require('../model');
const { zonedParts } = require('../dates');

const DUST = D('0.00000001');

function lotFromBuy(t) {
  const A = D(t.amount), T = D(t.total), F = D(t.fee);
  const unit = T.div(A);
  if (t.feeAsset === t.crypto) return { qty: A.minus(F), unit, fee: F.times(unit), feeValue: F.times(unit) };
  return { qty: A, unit, fee: F, feeValue: F };
}

class Pool {
  constructor(key) { this.key = key; this.lots = []; }
  add(lot) { this.lots.push(lot); }
  qty() { return this.lots.reduce((a, l) => a.plus(l.qty), ZERO); }
  value() { return this.lots.reduce((a, l) => a.plus(l.qty.times(l.unit)).plus(l.fee), ZERO); }
  /** Consume `q` unidades FIFO. Devuelve asignaciones y faltante. */
  consume(q) {
    const allocs = [];
    let left = D(q);
    while (left.gt(0) && this.lots.length) {
      const lot = this.lots[0];
      const x = Decimal_min(left, lot.qty);
      const whole = x.eq(lot.qty);
      const cost = x.times(lot.unit);
      const feeAlloc = whole ? lot.fee : lot.fee.times(x).div(lot.qty);
      allocs.push({ buyId: lot.tradeId, buyExchange: lot.exchange, buyDate: lot.dateUtc, qty: x, buyPrice: lot.unit, cost, buyFee: feeAlloc });
      lot.qty = lot.qty.minus(x); lot.fee = lot.fee.minus(feeAlloc);
      left = left.minus(x);
      if (lot.qty.lte(DUST)) {
        // residuo por redondeo del exchange: se traslada a la asignación para no perder ni un céntimo
        if (lot.qty.gt(0) || lot.fee.gt(0)) {
          const a = allocs[allocs.length - 1];
          a.qty = a.qty.plus(lot.qty); a.cost = a.cost.plus(lot.qty.times(lot.unit)); a.buyFee = a.buyFee.plus(lot.fee);
          left = left.minus(lot.qty).lt(0) ? ZERO : left.minus(lot.qty);
        }
        this.lots.shift();
      }
    }
    return { allocs, shortfall: left.lte(DUST) ? ZERO : left };
  }
}
const Decimal_min = (a, b) => (a.lt(b) ? a : b);

const sumA = (arr, k) => arr.reduce((a, x) => a.plus(x[k]), ZERO);
const monthKey = (iso, tz) => { const p = zonedParts(Date.parse(iso), tz); return `${p.year}-${String(p.month).padStart(2, '0')}`; };

/**
 * @param {object} state  { trades, costs, cycles }
 * @param {object} o      { fromMs, toMs, tz }
 */
function compute(state, o = {}) {
  const tz = o.tz || 'America/Lima';
  const fromMs = o.fromMs ?? -Infinity, toMs = o.toMs ?? Infinity;
  const inPeriod = (iso) => { const ms = Date.parse(iso); return ms >= fromMs && ms < toMs; };
  const beforeEnd = (iso) => Date.parse(iso) < toMs;

  const issues = [];
  const tradeInfo = new Map();
  const manualCycles = new Map((state.cycles || []).map((c) => [c.id, c]));

  // 1) Clasificación de operaciones
  for (const t of state.trades) {
    if (t.deleted) continue;
    const vi = validateTrade(t);
    for (const i of vi) issues.push({ ...i, tradeId: t.id, orderId: t.orderId, exchange: t.exchange, pair: t.pair, dateUtc: t.dateUtc });
    let excluded = null;
    if (t.status !== STATUS.COMPLETED) excluded = `estado "${t.status}"`;
    else if (!isCountable(t, vi)) excluded = 'inconsistencia bloqueante (ver incidencias)';
    if (!excluded && t.cycleId && !manualCycles.has(t.cycleId)) {
      excluded = `asignada al ciclo inexistente ${t.cycleId}`;
      issues.push({ code: 'CICLO_INEXISTENTE', severity: 'error', message: `Asignada a un ciclo que no existe (${t.cycleId}).`, tradeId: t.id, pair: t.pair, dateUtc: t.dateUtc });
    }
    if (!excluded && t.cycleId && manualCycles.get(t.cycleId).pair !== t.pair) {
      excluded = `par ${t.pair} incompatible con el ciclo ${t.cycleId} (${manualCycles.get(t.cycleId).pair})`;
      issues.push({ code: 'CICLO_PAR_INCOMPATIBLE', severity: 'error', message: `La operación ${t.pair} no puede pertenecer al ciclo ${manualCycles.get(t.cycleId).name} (${manualCycles.get(t.cycleId).pair}); no se mezclan mercados.`, tradeId: t.id, pair: t.pair, dateUtc: t.dateUtc });
    }
    tradeInfo.set(t.id, { trade: t, countable: !excluded, excluded });
  }

  // 2) Eventos por "pool": un pool por par (automático) y uno por ciclo manual
  const pools = new Map();
  const poolFor = (key, pair) => { if (!pools.has(key)) pools.set(key, { key, pair, events: [] }); return pools.get(key); };
  for (const { trade: t, countable } of tradeInfo.values()) {
    if (!countable || !beforeEnd(t.dateUtc)) continue;
    const key = t.cycleId ? `cycle:${t.cycleId}` : `pair:${t.pair}`;
    poolFor(key, t.pair).events.push({ kind: t.side, t, dateUtc: t.dateUtc });
  }
  for (const c of state.costs || []) {
    if (c.deleted) continue;
    const [crypto, fiat] = String(c.pair).split('/');
    const asset = String(c.asset).toUpperCase();
    if (asset !== crypto && asset !== fiat) {
      issues.push({ code: 'COSTO_MONEDA', severity: 'error', message: `El costo "${c.description}" está en ${asset}, que no pertenece al par ${c.pair}; no se contabiliza.`, costId: c.id, pair: c.pair, dateUtc: c.dateUtc });
      continue;
    }
    if (c.cycleId && !manualCycles.has(c.cycleId)) {
      issues.push({ code: 'CICLO_INEXISTENTE', severity: 'error', message: `Costo asignado a un ciclo inexistente (${c.cycleId}).`, costId: c.id, pair: c.pair, dateUtc: c.dateUtc });
      continue;
    }
    if (c.cycleId && manualCycles.get(c.cycleId).pair !== c.pair) {
      issues.push({ code: 'CICLO_PAR_INCOMPATIBLE', severity: 'error', message: `El costo del par ${c.pair} no puede asignarse al ciclo ${c.cycleId}.`, costId: c.id, pair: c.pair, dateUtc: c.dateUtc });
      continue;
    }
    if (!beforeEnd(c.dateUtc)) continue;
    const key = c.cycleId ? `cycle:${c.cycleId}` : `pair:${c.pair}`;
    poolFor(key, c.pair).events.push({ kind: 'cost', c, crypto, fiat, dateUtc: c.dateUtc });
  }

  const ORDER = { buy: 0, cost: 1, sell: 2 };
  const cycles = [], allocations = [], costRows = [], feeRows = [];
  const pairAgg = new Map();
  const agg = (pair) => {
    if (!pairAgg.has(pair)) {
      const [crypto, fiat] = pair.split('/');
      pairAgg.set(pair, { pair, crypto, fiat,
        buys: { count: 0, qty: ZERO, fiat: ZERO }, sells: { count: 0, qty: ZERO, fiat: ZERO },
        gross: ZERO, fees: ZERO, otherCosts: ZERO, net: ZERO, costOfSales: ZERO, proceeds: ZERO,
        unrecognizedProceeds: ZERO, openingInventory: { qty: ZERO, cost: ZERO }, closingInventory: { qty: ZERO, cost: ZERO },
        cash: { in: ZERO, out: ZERO }, cycles: 0 });
    }
    return pairAgg.get(pair);
  };

  for (const pool of pools.values()) {
    pool.events.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc) || ORDER[a.kind] - ORDER[b.kind]
      || String(a.t?.id || a.c?.id).localeCompare(String(b.t?.id || b.c?.id)));
    const inv = new Pool(pool.key);
    const A = agg(pool.pair);
    const isManual = pool.key.startsWith('cycle:');
    const manual = isManual ? { id: pool.key.slice(6), gross: ZERO, fees: ZERO, other: ZERO, proceeds: ZERO, cost: ZERO,
      shortfall: false, trades: [], buyExchanges: new Set(), sellExchanges: new Set(), first: null, last: null, unrecognized: ZERO } : null;
    let openingTaken = false;

    for (const ev of pool.events) {
      if (!openingTaken && Date.parse(ev.dateUtc) >= fromMs) {
        A.openingInventory.qty = A.openingInventory.qty.plus(inv.qty());
        A.openingInventory.cost = A.openingInventory.cost.plus(inv.value());
        openingTaken = true;
      }
      const inP = inPeriod(ev.dateUtc);
      if (ev.kind === 'buy') {
        const t = ev.t;
        const l = lotFromBuy(t);
        inv.add({ ...l, tradeId: t.id, exchange: t.exchange, dateUtc: t.dateUtc });
        if (inP) {
          A.buys.count++; A.buys.qty = A.buys.qty.plus(t.amount); A.buys.fiat = A.buys.fiat.plus(t.total);
          A.cash.out = A.cash.out.plus(t.total).plus(t.feeAsset === t.fiat ? t.fee : 0);
          if (D(t.fee).gt(0)) feeRows.push({ tradeId: t.id, orderId: t.orderId, exchange: t.exchange, pair: t.pair, side: 'buy', dateUtc: t.dateUtc, fee: D(t.fee), feeAsset: t.feeAsset, feeValue: l.feeValue, valuation: t.feeAsset === t.crypto ? 'precio de la compra' : 'monto fiat' });
        }
        if (manual) { manual.trades.push(t.id); manual.buyExchanges.add(t.exchange); manual.first = manual.first || t.dateUtc; manual.last = t.dateUtc; }
        tradeInfo.get(t.id).cycleRef = manual ? manual.id : null;
      } else if (ev.kind === 'sell') {
        const t = ev.t;
        const Aq = D(t.amount), T = D(t.total), F = D(t.fee);
        const sale = inv.consume(Aq);
        const covered = Aq.minus(sale.shortfall);
        const r = Aq.isZero() ? ZERO : covered.div(Aq);
        const proceeds = T.times(r);
        const unrecognized = T.minus(proceeds);
        const costBasis = sumA(sale.allocs, 'cost');
        const buyFees = sumA(sale.allocs, 'buyFee');
        let sellFee = ZERO, cryptoFeeShort = ZERO, feeAllocs = [];
        if (F.gt(0)) {
          if (t.feeAsset === t.fiat) sellFee = F.times(r);
          else {
            const fc = inv.consume(F.times(r));
            feeAllocs = fc.allocs; cryptoFeeShort = fc.shortfall;
            sellFee = sumA(fc.allocs, 'cost').plus(sumA(fc.allocs, 'buyFee'));
          }
        }
        const gross = proceeds.minus(costBasis);
        const fees = buyFees.plus(sellFee);
        const net = gross.minus(fees);
        const cycleId = manual ? manual.id : `C-${t.id}`;
        const status = sale.shortfall.gt(0) || cryptoFeeShort.gt(0) ? 'incompleto' : 'completo';
        if (sale.shortfall.gt(0)) {
          issues.push({ code: 'VENTA_SIN_COMPRA', severity: 'warning', tradeId: t.id, orderId: t.orderId, exchange: t.exchange, pair: t.pair, dateUtc: t.dateUtc,
            message: `Se vendieron ${Aq.toFixed()} ${t.crypto} pero solo había ${covered.toFixed()} con compra registrada en ${t.pair}${manual ? ' (ciclo ' + manual.id + ')' : ''}. `
              + `Los ${T.minus(proceeds).toDecimalPlaces(2).toFixed()} ${t.fiat} sin costo conocido NO se cuentan como ganancia.` });
        }
        if (cryptoFeeShort.gt(0)) {
          issues.push({ code: 'COMISION_SIN_INVENTARIO', severity: 'warning', tradeId: t.id, pair: t.pair, dateUtc: t.dateUtc,
            message: `La comisión de ${cryptoFeeShort.toFixed()} ${t.crypto} no tiene compra asociada para valorizarla.` });
        }
        tradeInfo.get(t.id).cycleRef = cycleId;
        for (const a of sale.allocs) {
          if (tradeInfo.get(a.buyId)) tradeInfo.get(a.buyId).cycleRefs = [...(tradeInfo.get(a.buyId).cycleRefs || []), cycleId];
        }
        if (inP) {
          A.sells.count++; A.sells.qty = A.sells.qty.plus(Aq); A.sells.fiat = A.sells.fiat.plus(T);
          A.proceeds = A.proceeds.plus(proceeds); A.costOfSales = A.costOfSales.plus(costBasis);
          A.gross = A.gross.plus(gross); A.fees = A.fees.plus(fees); A.net = A.net.plus(net);
          A.unrecognizedProceeds = A.unrecognizedProceeds.plus(unrecognized);
          A.cash.in = A.cash.in.plus(proceeds).minus(t.feeAsset === t.fiat ? sellFee : 0);
          if (F.gt(0)) feeRows.push({ tradeId: t.id, orderId: t.orderId, exchange: t.exchange, pair: t.pair, side: 'sell', dateUtc: t.dateUtc, fee: F, feeAsset: t.feeAsset, feeValue: sellFee, valuation: t.feeAsset === t.crypto ? 'costo FIFO de las unidades' : 'monto fiat' });
          if (!manual) {
            A.cycles++;
            cycles.push({
              id: cycleId, kind: 'automatico', pair: t.pair, status, closedAt: t.dateUtc, openedAt: sale.allocs[0]?.buyDate || t.dateUtc,
              buyExchanges: [...new Set(sale.allocs.map((a) => a.buyExchange))], sellExchange: t.exchange,
              buyTradeIds: [...new Set(sale.allocs.map((a) => a.buyId))], sellTradeIds: [t.id],
              qty: covered, avgBuyPrice: covered.gt(0) ? costBasis.div(covered) : ZERO, sellPrice: D(t.price),
              proceeds, costBasis, gross, fees, buyFees, sellFee, otherCosts: ZERO, net,
              marginPct: costBasis.gt(0) ? net.div(costBasis).times(100) : null, unrecognizedProceeds: unrecognized,
            });
          }
          for (const a of sale.allocs) allocations.push({ cycleId, sellId: t.id, sellDate: t.dateUtc, sellExchange: t.exchange, pair: t.pair, ...a, purpose: 'venta' });
          for (const a of feeAllocs) allocations.push({ cycleId, sellId: t.id, sellDate: t.dateUtc, sellExchange: t.exchange, pair: t.pair, ...a, purpose: 'comisión en cripto' });
        }
        if (manual) {
          manual.trades.push(t.id); manual.sellExchanges.add(t.exchange); manual.first = manual.first || t.dateUtc; manual.last = t.dateUtc;
          manual.gross = manual.gross.plus(gross); manual.fees = manual.fees.plus(fees); manual.proceeds = manual.proceeds.plus(proceeds);
          manual.cost = manual.cost.plus(costBasis); manual.unrecognized = manual.unrecognized.plus(unrecognized);
          if (status === 'incompleto') manual.shortfall = true;
        }
      } else if (ev.kind === 'cost') {
        const c = ev.c;
        const amt = D(c.amount);
        let value = ZERO, note = '';
        if (String(c.asset).toUpperCase() === ev.fiat) { value = amt; if (inP) A.cash.out = A.cash.out.plus(amt); }
        else {
          const cc = inv.consume(amt);
          value = sumA(cc.allocs, 'cost').plus(sumA(cc.allocs, 'buyFee'));
          if (cc.shortfall.gt(0)) {
            note = `faltante de inventario ${cc.shortfall.toFixed()} ${ev.crypto} (sin valorizar)`;
            issues.push({ code: 'COSTO_SIN_INVENTARIO', severity: 'warning', costId: c.id, pair: c.pair, dateUtc: c.dateUtc,
              message: `El costo "${c.description}" consume ${amt.toFixed()} ${ev.crypto} pero faltan ${cc.shortfall.toFixed()} en inventario; esa parte no se valoriza.` });
          }
        }
        if (inP) {
          A.otherCosts = A.otherCosts.plus(value); A.net = A.net.minus(value);
          costRows.push({ id: c.id, dateUtc: c.dateUtc, pair: c.pair, asset: c.asset, amount: amt, value, description: c.description, cycleId: c.cycleId || null, exchange: c.exchange || null, note });
        }
        if (manual) manual.other = manual.other.plus(value);
      }
    }
    if (!openingTaken) {
      A.openingInventory.qty = A.openingInventory.qty.plus(inv.qty());
      A.openingInventory.cost = A.openingInventory.cost.plus(inv.value());
    }
    A.closingInventory.qty = A.closingInventory.qty.plus(inv.qty());
    A.closingInventory.cost = A.closingInventory.cost.plus(inv.value());
    for (const lot of inv.lots) {
      if (lot.qty.gt(DUST)) {
        const ti = tradeInfo.get(lot.tradeId);
        if (ti) ti.openQty = lot.qty;
      }
    }

    if (manual) {
      const mc = manualCycles.get(manual.id);
      const openQty = inv.qty();
      const status = manual.shortfall ? 'incompleto' : openQty.gt(DUST) ? 'abierto' : 'completo';
      const net = manual.gross.minus(manual.fees).minus(manual.other);
      const pending = state.trades.filter((t) => !t.deleted && t.cycleId === manual.id && t.status !== STATUS.COMPLETED).length;
      if (pending) issues.push({ code: 'CICLO_CON_PENDIENTES', severity: 'warning', message: `El ciclo "${mc.name}" tiene ${pending} operación(es) no completadas que no se contabilizan.`, cycleId: manual.id, pair: mc.pair });
      if (openQty.gt(DUST)) issues.push({ code: 'COMPRA_SIN_VENTA', severity: 'info', message: `El ciclo "${mc.name}" conserva ${openQty.toFixed()} ${mc.pair.split('/')[0]} comprados sin vender.`, cycleId: manual.id, pair: mc.pair });
      if (!manual.last || !inPeriod(manual.last)) continue;
      A.cycles++;
      cycles.push({
        id: manual.id, name: mc.name, kind: 'manual', pair: mc.pair, status, openedAt: manual.first, closedAt: manual.last,
        buyExchanges: [...manual.buyExchanges], sellExchange: [...manual.sellExchanges].join(', '),
        buyTradeIds: manual.trades.filter((id) => tradeInfo.get(id)?.trade.side === 'buy'),
        sellTradeIds: manual.trades.filter((id) => tradeInfo.get(id)?.trade.side === 'sell'),
        qty: manual.cost.gt(0) ? sumA(allocations.filter((a) => a.cycleId === manual.id && a.purpose === 'venta'), 'qty') : ZERO,
        proceeds: manual.proceeds, costBasis: manual.cost, gross: manual.gross, fees: manual.fees, otherCosts: manual.other, net,
        marginPct: manual.cost.gt(0) ? net.div(manual.cost).times(100) : null, unrecognizedProceeds: manual.unrecognized,
        openQty, openCost: inv.value(),
      });
    }
  }

  // 3) Controles globales
  duplicateCheck(state.trades, issues);
  const now = Date.now();
  for (const t of state.trades) {
    if (!t.deleted && t.status === STATUS.PENDING && now - Date.parse(t.dateUtc) > 48 * 3600e3) {
      issues.push({ code: 'PENDIENTE_ANTIGUA', severity: 'warning', tradeId: t.id, orderId: t.orderId, exchange: t.exchange, pair: t.pair, dateUtc: t.dateUtc,
        message: 'Sigue pendiente después de 48 h. Vuelva a sincronizar/importar para actualizar su estado.' });
    }
  }
  for (const [id, ti] of tradeInfo) {
    if (ti.countable && ti.trade.side === 'buy' && ti.openQty && inPeriod(ti.trade.dateUtc) && !ti.trade.cycleId) {
      issues.push({ code: 'COMPRA_SIN_VENTA', severity: 'info', tradeId: id, orderId: ti.trade.orderId, exchange: ti.trade.exchange, pair: ti.trade.pair, dateUtc: ti.trade.dateUtc,
        message: `Quedan ${ti.openQty.toFixed()} ${ti.trade.crypto} de esta compra en inventario (sin venta asociada al cierre del período).` });
    }
  }

  // 4) Conciliación por par: resultado neto = flujo de caja del período + variación de inventario a costo
  const pairs = [...pairAgg.values()].sort((a, b) => a.pair.localeCompare(b.pair));
  for (const p of pairs) {
    const deltaInv = p.closingInventory.cost.minus(p.openingInventory.cost);
    const cashNet = p.cash.in.minus(p.cash.out);
    const diff = cashNet.plus(deltaInv).minus(p.net);
    p.reconciliation = { cashNet, deltaInventory: deltaInv, net: p.net, difference: diff, ok: diff.abs().lte('0.000001') };
    if (!p.reconciliation.ok) {
      issues.push({ code: 'CONCILIACION', severity: 'error', pair: p.pair, message: `La conciliación de ${p.pair} no cuadra por ${diff.toFixed()} ${p.fiat}. Reporte este caso.` });
    }
    p.closingInventory.avgCost = p.closingInventory.qty.gt(DUST) ? p.closingInventory.cost.div(p.closingInventory.qty) : ZERO;
  }

  // 5) Agregados por exchange y por mes (resultado atribuido al exchange/mes donde se cierra la venta)
  const byExchange = new Map(), byMonth = new Map();
  const bump = (m, k, init) => { if (!m.has(k)) m.set(k, init()); return m.get(k); };
  for (const ti of tradeInfo.values()) {
    const t = ti.trade;
    if (!ti.countable || !inPeriod(t.dateUtc)) continue;
    const e = bump(byExchange, `${t.pair}|${t.exchange}`, () => ({ pair: t.pair, exchange: t.exchange, buys: 0, buyQty: ZERO, buyFiat: ZERO, sells: 0, sellQty: ZERO, sellFiat: ZERO, fees: ZERO, gross: ZERO, net: ZERO }));
    if (t.side === 'buy') { e.buys++; e.buyQty = e.buyQty.plus(t.amount); e.buyFiat = e.buyFiat.plus(t.total); }
    else { e.sells++; e.sellQty = e.sellQty.plus(t.amount); e.sellFiat = e.sellFiat.plus(t.total); }
  }
  for (const f of feeRows) { const e = byExchange.get(`${f.pair}|${f.exchange}`); if (e) e.fees = e.fees.plus(f.feeValue); }
  for (const c of cycles) {
    if (c.kind === 'automatico') {
      const e = byExchange.get(`${c.pair}|${c.sellExchange}`); if (e) { e.gross = e.gross.plus(c.gross); e.net = e.net.plus(c.net); }
    }
    const m = bump(byMonth, `${c.pair}|${monthKey(c.closedAt, tz)}`, () => ({ pair: c.pair, month: monthKey(c.closedAt, tz), cycles: 0, proceeds: ZERO, costBasis: ZERO, gross: ZERO, fees: ZERO, otherCosts: ZERO, net: ZERO }));
    m.cycles++; m.proceeds = m.proceeds.plus(c.proceeds); m.costBasis = m.costBasis.plus(c.costBasis);
    m.gross = m.gross.plus(c.gross); m.fees = m.fees.plus(c.fees); m.otherCosts = m.otherCosts.plus(c.otherCosts); m.net = m.net.plus(c.net);
  }
  for (const c of costRows.filter((x) => !x.cycleId)) {
    const m = bump(byMonth, `${c.pair}|${monthKey(c.dateUtc, tz)}`, () => ({ pair: c.pair, month: monthKey(c.dateUtc, tz), cycles: 0, proceeds: ZERO, costBasis: ZERO, gross: ZERO, fees: ZERO, otherCosts: ZERO, net: ZERO }));
    m.otherCosts = m.otherCosts.plus(c.value); m.net = m.net.minus(c.value);
  }

  return {
    period: { fromMs: Number.isFinite(fromMs) ? fromMs : null, toMs: Number.isFinite(toMs) ? toMs : null, tz },
    pairs, cycles: cycles.sort((a, b) => a.closedAt.localeCompare(b.closedAt)), allocations, costs: costRows, fees: feeRows,
    byExchange: [...byExchange.values()].sort((a, b) => a.pair.localeCompare(b.pair) || a.exchange.localeCompare(b.exchange)),
    byMonth: [...byMonth.values()].sort((a, b) => a.pair.localeCompare(b.pair) || a.month.localeCompare(b.month)),
    tradeInfo, issues,
  };
}

/** Posibles duplicados con distinto ID/huella: mismo exchange, lado, par, cantidad y total, con ≤ 2 min de diferencia. */
function duplicateCheck(trades, issues) {
  const buckets = new Map();
  for (const t of trades) {
    if (t.deleted) continue;
    const k = [t.exchange, t.side, t.pair, D(t.amount).toFixed(), D(t.total).toFixed()].join('|');
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(t);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      if (Date.parse(b.dateUtc) - Date.parse(a.dateUtc) <= 120000 && (!a.orderId || !b.orderId || (a.counterparty && a.counterparty === b.counterparty))) {
        issues.push({ code: 'POSIBLE_DUPLICADO', severity: 'warning', tradeId: b.id, orderId: b.orderId, exchange: b.exchange, pair: b.pair, dateUtc: b.dateUtc,
          message: `Coincide en montos y hora (±2 min) con ${a.id}. Si es la misma orden, elimine una de las dos.` });
      }
    }
  }
}

/** Serializa Decimals para JSON: string decimal con hasta 12 decimales (el cálculo interno es exacto). */
function toJSONSafe(v) {
  if (v && typeof v === 'object' && typeof v.toFixed === 'function' && v.constructor && v.constructor.name === 'Decimal') return str(v.toDecimalPlaces(12));
  if (v instanceof Set) return [...v];
  if (v instanceof Map) return undefined;
  if (Array.isArray(v)) return v.map(toJSONSafe);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) { const y = toJSONSafe(x); if (y !== undefined) o[k] = y; }
    return o;
  }
  return v;
}

module.exports = { compute, toJSONSafe, lotFromBuy };

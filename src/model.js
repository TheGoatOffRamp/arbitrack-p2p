'use strict';
const crypto = require('crypto');
const { D, str } = require('./money');
const { parseSourceDate, toLocalMinute, cleanCell, DEFAULT_TZ } = require('./dates');
const { parseAmount } = require('./numbers');

// ── Estados ────────────────────────────────────────────────────────────────
// Solo 'completado' se contabiliza. Todo lo demás queda fuera de resultados y saldos.
const STATUS = Object.freeze({
  COMPLETED: 'completado', PENDING: 'pendiente', CANCELLED: 'cancelado',
  FAILED: 'fallido', DISPUTE: 'en_disputa', UNKNOWN: 'desconocido',
});
const COUNTABLE = new Set([STATUS.COMPLETED]);

const STATUS_WORDS = [
  [STATUS.COMPLETED, ['completed', 'complete', 'completado', 'completada', 'finished', 'finish', 'finalizado', 'finalizada',
    'done', 'success', 'successful', 'exitoso', 'exitosa', 'filled', 'released', 'liberado', 'liberada', 'terminado', 'cerrado', 'order finished']],
  [STATUS.CANCELLED, ['cancelled', 'canceled', 'cancel', 'cancelado', 'cancelada', 'anulado', 'anulada', 'expired', 'expirado',
    'expirada', 'timeout', 'cancelled_by_system', 'system cancelled', 'cancelado por el sistema', 'order cancelled', 'exception cancelled']],
  [STATUS.FAILED, ['failed', 'fail', 'rejected', 'rechazado', 'rechazada', 'fallido', 'fallida', 'error', 'pay fail', 'payment failed']],
  [STATUS.DISPUTE, ['appeal', 'appealing', 'in_appeal', 'in appeal', 'dispute', 'disputa', 'en disputa', 'apelacion', 'apelación',
    'objectioning', 'en apelación', 'en apelacion']],
  [STATUS.PENDING, ['pending', 'pendiente', 'processing', 'procesando', 'en proceso', 'trading', 'paid', 'pagado', 'buyer_payed',
    'buyer_paid', 'waiting', 'esperando', 'unpaid', 'pending_pay', 'in progress', 'distributing', 'to be released', 'por liberar',
    'waiting for payment', 'waiting for release', 'en curso', 'abierto', 'abierta', 'open']],
];
const STATUS_MAP = new Map();
for (const [st, words] of STATUS_WORDS) for (const w of words) STATUS_MAP.set(w, st);

function normalizeStatus(raw) {
  const s = cleanCell(raw).toLowerCase().replace(/\s+/g, ' ');
  if (!s) return STATUS.UNKNOWN;
  if (Object.values(STATUS).includes(s)) return s;
  return STATUS_MAP.get(s) || STATUS_MAP.get(s.replace(/[_-]/g, ' ')) || STATUS.UNKNOWN;
}

// ── Lados ──────────────────────────────────────────────────────────────────
const BUY_WORDS = new Set(['buy', 'compra', 'comprar', 'purchase', 'bought', 'b', 'compraste', 'comprado']);
const SELL_WORDS = new Set(['sell', 'venta', 'vender', 'sold', 's', 'vendiste', 'vendido']);
function normalizeSide(raw) {
  const s = cleanCell(raw).toLowerCase();
  if (BUY_WORDS.has(s) || /^(buy|compra)\b/.test(s)) return 'buy';
  if (SELL_WORDS.has(s) || /^(sell|venta)\b/.test(s)) return 'sell';
  return null;
}

// ── Exchanges ──────────────────────────────────────────────────────────────
const EXCHANGES = { binance: 'Binance', bybit: 'Bybit', bitget: 'Bitget', okx: 'OKX', eldorado: 'El Dorado', kucoin: 'KuCoin' };
function canonicalExchange(raw) {
  const k = cleanCell(raw).toLowerCase().replace(/[\s_.-]/g, '').replace(/p2p$/, '');
  return EXCHANGES[k] || (cleanCell(raw) || null);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const normCode = (s) => cleanCell(s).toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
const normId = (s) => cleanCell(s).replace(/\s+/g, '') || null;

// ── Construcción y validación de una operación normalizada ─────────────────
const EDITABLE_FIELDS = ['side', 'type', 'date', 'dateUtc', 'exchange', 'orderId', 'crypto', 'fiat', 'amount', 'price', 'total',
  'fee', 'feeAsset', 'status', 'counterparty', 'payMethod', 'notes', 'cycleId'];

/**
 * Convierte un "candidato" (campos crudos de CSV/API/manual) en una operación canónica.
 * Nunca inventa datos: las derivaciones (precio = total/cantidad, etc.) quedan registradas en `derived`.
 * @returns {{trade?:object, rejected?:{reasons:string[]}, issues:object[]}}
 */
function buildTrade(c, ctx = {}) {
  const reasons = [];
  const issues = [];
  const derived = [];
  const tz = ctx.tz || DEFAULT_TZ;

  const exchange = canonicalExchange(c.exchange || ctx.exchange);
  if (!exchange) reasons.push('exchange no identificado');

  const side = normalizeSide(c.side ?? c.type);
  if (!side) reasons.push(`tipo de operación no reconocido: "${cleanCell(c.side ?? c.type)}"`);

  const crypto = normCode(c.crypto);
  const fiat = normCode(c.fiat);
  if (!crypto) reasons.push('moneda cripto (base) ausente');
  if (!fiat) reasons.push('moneda fiat (cotizada) ausente');
  if (crypto && fiat && crypto === fiat) reasons.push(`par inválido ${crypto}/${fiat}`);

  let dateMs = null;
  if (c.dateUtc) {
    const r = parseSourceDate(c.dateUtc, { tz: 'UTC' });
    if (r.ok) dateMs = r.ms; else reasons.push(`fecha: ${r.error}`);
  } else if (c.date instanceof Date || (c.date !== undefined && c.date !== null && c.date !== '')) {
    const r = parseSourceDate(c.date, { tz, dateOrder: ctx.dateOrder });
    if (r.ok) dateMs = r.ms; else reasons.push(`fecha: ${r.error}`);
  } else reasons.push('fecha ausente');
  if (dateMs !== null && dateMs > Date.now() + 36e5) reasons.push('fecha en el futuro');

  const numField = (name, required) => {
    const v = c[name];
    if (v === undefined || v === null || cleanCell(v) === '') return null;
    const r = parseAmount(v, ctx.decimal || null);
    if (!r.ok) { if (!r.empty) reasons.push(`${name}: ${r.error}`); return null; }
    return D(r.value);
  };
  let amount = numField('amount');
  let price = numField('price');
  let total = numField('total');
  let fee = numField('fee');

  // Derivaciones explícitas (solo si faltan y hay datos suficientes)
  if (amount && total && !price && !amount.isZero()) { price = total.div(amount).toDecimalPlaces(10); derived.push('precio = total / cantidad'); }
  if (amount && price && !total) { total = amount.times(price); derived.push('total = cantidad × precio'); }
  if (!amount && price && total && !price.isZero()) { amount = total.div(price).toDecimalPlaces(10); derived.push('cantidad = total / precio'); }
  if (!amount) reasons.push('cantidad cripto ausente o inválida');
  if (!total) reasons.push('monto total fiat ausente o inválido');
  if (!price) reasons.push('precio ausente o inválido');
  for (const [k, v] of [['cantidad', amount], ['total', total], ['precio', price]]) {
    if (v && v.lte(0)) reasons.push(`${k} debe ser mayor que 0 (recibido ${v.toFixed()}); no se cambia el signo automáticamente`);
  }

  let status = normalizeStatus(c.status);
  const statusRaw = cleanCell(c.status);
  if (!statusRaw && ctx.source === 'manual') {
    status = STATUS.COMPLETED;
    derived.push('estado = completado (registro manual enviado sin estado)');
  }

  if (reasons.length) return { rejected: { reasons }, issues };

  // Comisión
  if (!fee) fee = D(0);
  let feeAsset = normCode(c.feeAsset) || null;
  if (fee.isNegative()) return { rejected: { reasons: ['comisión negativa'] }, issues };

  const orderId = normId(c.orderId);
  const dateUtc = new Date(dateMs).toISOString();
  const trade = {
    id: null,
    exchange,
    orderId,
    side,
    type: side === 'buy' ? 'compra' : 'venta',
    crypto,
    fiat,
    pair: `${crypto}/${fiat}`,
    amount: str(amount),
    price: str(price),
    total: str(total),
    fee: str(fee),
    feeAsset: fee.isZero() ? (feeAsset || crypto) : feeAsset,
    status,
    statusRaw: statusRaw || null,
    dateUtc,
    date: toLocalMinute(dateMs, tz),
    counterparty: cleanCell(c.counterparty) || null,
    payMethod: cleanCell(c.payMethod) || null,
    notes: cleanCell(c.notes) || null,
    source: ctx.source || 'manual',
    sourceRef: ctx.sourceRef || null,
    derived,
    raw: c.raw !== undefined ? c.raw : null,
    cycleId: c.cycleId ? String(c.cycleId) : null,
    feeUnknown: !!c.feeUnknown,
  };
  trade.dedupKey = dedupKey(trade);
  trade.id = trade.orderId ? `${slug(exchange)}_${trade.orderId}` : `${slug(exchange)}_${trade.dedupKey.slice(3, 19)}`;
  return { trade, issues: issues.concat(validateTrade(trade)) };
}

function dedupKey(t) {
  if (t.orderId) return `id:${slug(t.exchange)}:${t.orderId}`;
  const h = crypto.createHash('sha256')
    .update([slug(t.exchange), t.side, t.dateUtc, D(t.amount).toFixed(), D(t.price).toFixed(), D(t.total).toFixed(),
      (t.counterparty || '').toLowerCase()].join('|'))
    .digest('hex');
  return `fp:${h}`;
}

/**
 * Controles de consistencia de una operación ya normalizada.
 * severity 'error' → la operación queda EXCLUIDA de la contabilidad hasta que se corrija.
 */
function validateTrade(t) {
  const out = [];
  const amount = D(t.amount), price = D(t.price), total = D(t.total), fee = D(t.fee);
  if (amount.lte(0)) out.push({ code: 'CANTIDAD_NO_POSITIVA', severity: 'error', message: 'La cantidad cripto debe ser mayor que 0.' });
  if (total.lte(0)) out.push({ code: 'TOTAL_NO_POSITIVO', severity: 'error', message: 'El total fiat debe ser mayor que 0.' });
  if (price.lte(0)) out.push({ code: 'PRECIO_NO_POSITIVO', severity: 'error', message: 'El precio debe ser mayor que 0.' });
  if (amount.gt(0) && price.gt(0) && total.gt(0)) {
    const calc = amount.times(price);
    const diff = calc.minus(total).abs();
    const tol = total.times('0.001').plus('0.01'); // redondeo del exchange
    if (diff.gt(tol)) {
      const pct = diff.div(total).times(100);
      out.push({
        code: 'TOTAL_INCONSISTENTE', severity: pct.gt(2) ? 'error' : 'warning',
        message: `cantidad × precio = ${calc.toDecimalPlaces(4).toFixed()} ≠ total ${total.toFixed()} ${t.fiat} (dif. ${pct.toDecimalPlaces(3).toFixed()}%).`
          + (pct.gt(2) ? ' Posible columna mal mapeada; se excluye de los cálculos.' : ''),
      });
    }
  }
  if (fee.gt(0)) {
    if (t.feeAsset !== t.crypto && t.feeAsset !== t.fiat) {
      out.push({ code: 'COMISION_MONEDA', severity: 'error',
        message: `La comisión (${fee.toFixed()}) está en "${t.feeAsset || 'moneda desconocida'}", que no pertenece al par ${t.pair}. Se excluye hasta definir la moneda.` });
    } else {
      const base = t.feeAsset === t.crypto ? amount : total;
      if (base.gt(0) && fee.div(base).gt('0.05')) {
        out.push({ code: 'COMISION_ALTA', severity: 'warning', message: `Comisión superior al 5% de la operación (${fee.toFixed()} ${t.feeAsset}).` });
      }
      if (t.side === 'buy' && t.feeAsset === t.crypto && fee.gte(amount)) {
        out.push({ code: 'COMISION_MAYOR_CANTIDAD', severity: 'error', message: 'La comisión en cripto es mayor o igual a la cantidad comprada.' });
      }
    }
  }
  if (t.feeUnknown && fee.isZero()) {
    out.push({ code: 'COMISION_NO_INFORMADA', severity: 'info',
      message: 'El exchange no informa la comisión en esta fuente; se registró 0. Verifique con el estado de cuenta.' });
  }
  if (t.status === STATUS.UNKNOWN) {
    out.push({ code: 'ESTADO_DESCONOCIDO', severity: 'warning', message: `Estado "${t.statusRaw || ''}" no reconocido: no se contabiliza.` });
  }
  if (!t.orderId) {
    out.push({ code: 'SIN_ID', severity: 'warning',
      message: 'Sin ID de orden del exchange: los duplicados se detectan por huella (exchange, fecha, montos, contraparte).' });
  }
  for (const d of t.derived || []) out.push({ code: 'DATO_DERIVADO', severity: 'info', message: `Calculado por ArbiTrack: ${d}.` });
  return out;
}

/** ¿Entra la operación en los resultados? */
function isCountable(t, issues = validateTrade(t)) {
  return !t.deleted && COUNTABLE.has(t.status) && !issues.some((i) => i.severity === 'error');
}

/** Vista para la webapp: números JS en los campos heredados + strings exactos en `exact`. */
function present(t) {
  const n = (v) => Number(D(v).toFixed());
  return {
    ...t,
    amount: n(t.amount), price: n(t.price), total: n(t.total), fee: n(t.fee),
    feeType: t.feeAsset === t.crypto ? 'crypto' : 'fiat',
    syncId: t.dedupKey,
    exact: { amount: t.amount, price: t.price, total: t.total, fee: t.fee },
  };
}

module.exports = {
  STATUS, COUNTABLE, EDITABLE_FIELDS, normalizeStatus, normalizeSide, canonicalExchange, slug, normCode, normId,
  buildTrade, validateTrade, isCountable, dedupKey, present,
};

'use strict';
// Adaptadores de API P2P. Cada adaptador:
//  1) pagina TODO el rango (por ventanas), con reintentos;
//  2) valida la estructura de cada registro;
//  3) devuelve "candidatos" crudos que luego pasan por buildTrade (mismo camino que CSV).
// Si algo falla, lanza ApiError y el servidor NO guarda nada de esa sincronización.
const crypto = require('crypto');
const { requestJson, ApiError, windows } = require('./http');
const { STATUS } = require('../model');

const hmac = (secret, msg, enc) => crypto.createHmac('sha256', secret).update(msg).digest(enc);

function requireFields(item, fields, label) {
  const miss = fields.filter((f) => item[f] === undefined || item[f] === null || item[f] === '');
  return miss.length ? `${label}: faltan campos ${miss.join(', ')}` : null;
}

// ── Binance ── GET /sapi/v1/c2c/orderMatch/listUserOrderHistory
const BINANCE_STATUS = {
  COMPLETED: STATUS.COMPLETED, PENDING: STATUS.PENDING, TRADING: STATUS.PENDING, BUYER_PAYED: STATUS.PENDING,
  DISTRIBUTING: STATUS.PENDING, IN_APPEAL: STATUS.DISPUTE, CANCELLED: STATUS.CANCELLED, CANCELLED_BY_SYSTEM: STATUS.CANCELLED,
};

async function binance({ apiKey, apiSecret }, startMs, endMs, http = {}) {
  const base = http.baseUrl || 'https://api.binance.com';
  let offset = 0;
  try {
    const t = await requestJson(`${base}/api/v3/time`, { ...http, label: 'Binance time', retries: 1 });
    offset = t.serverTime - Date.now();
  } catch { offset = 0; }
  const out = [], schemaErrors = [];
  const rows = 50;
  for (const [ws, we] of windows(startMs, endMs, 30)) {
    for (const tradeType of ['BUY', 'SELL']) {
      for (let page = 1; page <= 1000; page++) {
        const p = new URLSearchParams({ tradeType, startTimestamp: String(ws), endTimestamp: String(we), page: String(page),
          rows: String(rows), recvWindow: '10000', timestamp: String(Date.now() + offset) });
        p.append('signature', hmac(apiSecret, p.toString(), 'hex'));
        const data = await requestJson(`${base}/sapi/v1/c2c/orderMatch/listUserOrderHistory?${p}`,
          { ...http, headers: { 'X-MBX-APIKEY': apiKey }, label: 'Binance' });
        if (!(data.code === '000000' || data.success === true)) {
          throw new ApiError(`Binance: ${data.message || data.msg || 'código ' + data.code}`, { body: data });
        }
        if (!Array.isArray(data.data)) throw new ApiError('Binance: respuesta sin lista "data" (estructura inesperada)');
        for (const t of data.data) {
          const err = requireFields(t, ['orderNumber', 'asset', 'fiat', 'amount', 'totalPrice', 'unitPrice', 'orderStatus', 'createTime'], `Binance orden ${t.orderNumber || '?'}`);
          if (err) { schemaErrors.push(err); continue; }
          const status = BINANCE_STATUS[t.orderStatus];
          out.push({
            exchange: 'Binance', orderId: String(t.orderNumber), side: t.tradeType || tradeType,
            crypto: t.asset, fiat: t.fiat, amount: String(t.amount), price: String(t.unitPrice), total: String(t.totalPrice),
            fee: t.commission !== undefined ? String(t.commission) : '0', feeAsset: t.asset,
            status: status || t.orderStatus, dateUtc: new Date(Number(t.createTime)).toISOString(),
            counterparty: t.counterPartNickName, payMethod: t.payMethodName, raw: t,
          });
        }
        if (data.data.length < rows || (data.total && page * rows >= Number(data.total))) break;
      }
    }
  }
  return { candidates: out, schemaErrors };
}

// ── Bybit ── POST /v5/p2p/order/simplifyList (side 0 = compra, 1 = venta)
const BYBIT_STATUS = {
  5: STATUS.PENDING, 10: STATUS.PENDING, 20: STATUS.PENDING, 30: STATUS.DISPUTE, 40: STATUS.CANCELLED, 50: STATUS.COMPLETED,
  60: STATUS.PENDING, 70: STATUS.FAILED, 80: STATUS.CANCELLED, 90: STATUS.PENDING, 100: STATUS.DISPUTE, 110: STATUS.DISPUTE,
};

async function bybit({ apiKey, apiSecret }, startMs, endMs, http = {}) {
  const base = http.baseUrl || 'https://api.bybit.com';
  const out = [], schemaErrors = [];
  const size = 30; // máximo documentado
  for (const [ws, we] of windows(startMs, endMs, 30)) {
    for (let page = 1; page <= 1000; page++) {
      const body = JSON.stringify({ page, size, beginTime: String(ws), endTime: String(we) });
      const ts = String(Date.now()), recv = '20000';
      const data = await requestJson(`${base}/v5/p2p/order/simplifyList`, {
        ...http, method: 'POST', body, label: 'Bybit',
        headers: { 'Content-Type': 'application/json', 'X-BAPI-API-KEY': apiKey, 'X-BAPI-TIMESTAMP': ts,
          'X-BAPI-RECV-WINDOW': recv, 'X-BAPI-SIGN': hmac(apiSecret, ts + apiKey + recv + body, 'hex') },
      });
      const code = data.ret_code ?? data.retCode;
      if (code !== 0) throw new ApiError(`Bybit: ${data.ret_msg || data.retMsg || 'código ' + code}`, { body: data });
      const items = data.result?.items;
      if (!Array.isArray(items)) throw new ApiError('Bybit: respuesta sin "result.items" (estructura inesperada)');
      for (const t of items) {
        const err = requireFields(t, ['id', 'side', 'tokenId', 'currencyId', 'amount', 'price', 'status', 'createDate'], `Bybit orden ${t.id || '?'}`);
        if (err) { schemaErrors.push(err); continue; }
        const side = Number(t.side) === 0 ? 'buy' : Number(t.side) === 1 ? 'sell' : null;
        if (!side) { schemaErrors.push(`Bybit orden ${t.id}: side desconocido "${t.side}"`); continue; }
        out.push({
          exchange: 'Bybit', orderId: String(t.id), side, crypto: t.tokenId, fiat: t.currencyId,
          amount: t.notifyTokenQuantity, // cantidad cripto; si falta se deriva de total/precio (queda registrado)
          price: t.price, total: t.amount, fee: t.fee ?? '0', feeAsset: t.tokenId,
          status: BYBIT_STATUS[Number(t.status)] || `bybit:${t.status}`,
          dateUtc: new Date(Number(t.createDate)).toISOString(), counterparty: t.targetNickName, raw: t,
        });
      }
      const count = Number(data.result.count || 0);
      if (items.length < size || page * size >= count) break;
    }
  }
  return { candidates: out, schemaErrors };
}

// ── Bitget ── GET /api/v2/p2p/orderList (solo comerciantes; count = cripto, amount = fiat)
const BITGET_STATUS = { pending_pay: STATUS.PENDING, paid: STATUS.PENDING, appeal: STATUS.DISPUTE, completed: STATUS.COMPLETED, cancelled: STATUS.CANCELLED };

async function bitget({ apiKey, apiSecret, passphrase }, startMs, endMs, http = {}) {
  const base = http.baseUrl || 'https://api.bitget.com';
  const path = '/api/v2/p2p/orderList';
  const out = [], schemaErrors = [];
  for (const [ws, we] of windows(startMs, endMs, 30)) {
    let idLessThan = null;
    for (let guard = 0; guard < 1000; guard++) {
      const q = new URLSearchParams({ startTime: String(ws), endTime: String(we), limit: '100' });
      if (idLessThan) q.set('idLessThan', idLessThan);
      const ts = String(Date.now());
      const sign = hmac(apiSecret, `${ts}GET${path}?${q}`, 'base64');
      const data = await requestJson(`${base}${path}?${q}`, {
        ...http, label: 'Bitget',
        headers: { 'ACCESS-KEY': apiKey, 'ACCESS-SIGN': sign, 'ACCESS-TIMESTAMP': ts, 'ACCESS-PASSPHRASE': passphrase || '',
          'Content-Type': 'application/json', locale: 'en-US' },
      });
      if (data.code !== '00000') throw new ApiError(`Bitget: ${data.msg || 'código ' + data.code}`, { body: data });
      const list = data.data?.orderList;
      if (!Array.isArray(list)) throw new ApiError('Bitget: respuesta sin "data.orderList" (estructura inesperada)');
      for (const t of list) {
        const err = requireFields(t, ['orderNo', 'coin', 'fiat', 'count', 'amount', 'price', 'status', 'ctime'], `Bitget orden ${t.orderNo || t.orderId || '?'}`);
        if (err) { schemaErrors.push(err); continue; }
        const sideRaw = String(t.side || t.type || '').toLowerCase();
        out.push({
          exchange: 'Bitget', orderId: String(t.orderNo), side: sideRaw, crypto: t.coin, fiat: t.fiat,
          amount: t.count, price: t.price, total: t.amount, fee: '0', feeAsset: t.coin, feeUnknown: true,
          status: BITGET_STATUS[String(t.status).toLowerCase()] || t.status,
          dateUtc: new Date(Number(t.ctime)).toISOString(),
          counterparty: sideRaw === 'buy' ? t.sellerRealName : t.buyerRealName,
          payMethod: t.paymentInfo?.paymethodName, raw: t,
        });
      }
      const next = data.data.minOrderId || data.data.minId;
      if (list.length < 100 || !next || next === idLessThan) break;
      idLessThan = next;
    }
  }
  return { candidates: out, schemaErrors };
}

const UNSUPPORTED = {
  okx: 'OKX no ofrece una API pública de historial P2P para cuentas normales (el backend anterior consultaba /otc/rfq/trade, que es el mercado RFQ institucional, no P2P). Importe el CSV/XLSX de OKX.',
  eldorado: 'El Dorado no tiene API pública. Importe el archivo exportado desde El Dorado.',
  kucoin: 'KuCoin P2P no está implementado. Importe el archivo exportado.',
};

const ADAPTERS = { binance, bybit, bitget };

module.exports = { ADAPTERS, UNSUPPORTED, BINANCE_STATUS, BYBIT_STATUS, BITGET_STATUS };

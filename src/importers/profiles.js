'use strict';
// Perfiles de exportación por exchange.
//
// Cada perfil declara QUÉ significa cada columna en ESE exchange. Nombres parecidos no implican el mismo
// significado: "Amount" es monto FIAT en Bitget, "Volumen" es cantidad CRIPTO en OKX, "Flat" es la moneda
// fiat en Bitget (error tipográfico del propio exchange). El perfil genérico NO mapea columnas ambiguas.
//
// Los perfiles de Bybit, Bitget, OKX (español) y El Dorado están verificados con exportaciones reales (sep-2026).
// El de Binance se basa en su formato documentado y debe confirmarse con un archivo real.

const norm = (h) => String(h ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[º°]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const FIELDS = ['orderId', 'side', 'crypto', 'fiat', 'pair', 'amount', 'price', 'total', 'fee', 'feeMaker', 'feeTaker',
  'feeAsset', 'status', 'date', 'completedAt', 'counterparty', 'payMethod', 'exchange'];
const REQUIRED = ['side', 'date', 'status'];

// ── Hora codificada en el ID de orden (sirve para deducir la zona horaria del archivo sin preguntar) ──
const ID_TIME = {
  // Bybit: ID "snowflake" con la época de Twitter (verificado: coincide al segundo con "Time (UTC-05:00)")
  snowflakeTwitter: (id) => {
    if (!/^\d{17,20}$/.test(id)) return null;
    try { return Number(BigInt(id) >> 22n) + 1288834974657; } catch { return null; }
  },
  // OKX: los 12 primeros dígitos son AAMMDDhhmmss en hora de Singapur/Beijing (UTC+8)
  okxUtc8: (id) => {
    const m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{3}$/.exec(id);
    if (!m) return null;
    const ms = Date.UTC(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600e3;
    return Number.isFinite(ms) ? ms : null;
  },
  // El Dorado: UUID versión 7 → los primeros 48 bits son milisegundos Unix
  uuidV7: (id) => {
    const h = String(id).replace(/-/g, '');
    if (!/^[0-9a-f]{32}$/i.test(h) || h[12] !== '7') return null;
    return parseInt(h.slice(0, 12), 16);
  },
};

// Método de pago de El Dorado ("app_yape_pe") → nombre legible
const ELDORADO_PAY = { app_yape_pe: 'Yape', app_plin_pe: 'Plin', bank_creditbank_pe: 'BCP (Banco de Crédito)', bank_interbank_pe: 'Interbank',
  bank_bbva_pe: 'BBVA Perú', bank_scotiabank_pe: 'Scotiabank Perú', bank_banbif_pe: 'BanBif', bank_bn_pe: 'Banco de la Nación',
  app_wise_us: 'Wise', app_binance_pay_usdt: 'Binance Pay' };

const PROFILES = [
  {
    id: 'binance-p2p', exchange: 'Binance', filenameHint: /binance/i, decimal: '.',
    signatures: [['order number', 'order type', 'asset type', 'fiat type', 'total price']],
    columns: {
      orderId: ['order number', 'order no', 'numero de orden'],
      side: ['order type', 'trade type', 'tipo de orden'],
      crypto: ['asset type', 'asset', 'activo'],
      fiat: ['fiat type', 'fiat', 'moneda fiat'],
      total: ['total price', 'precio total'],
      price: ['price', 'unit price', 'precio'],
      amount: ['quantity', 'cantidad'],
      feeMaker: ['maker fee', 'comision maker'],
      feeTaker: ['taker fee', 'comision taker'],
      fee: ['commission', 'fee', 'comision'],
      counterparty: ['couterparty', 'counterparty', 'contraparte'],
      status: ['status', 'estado'],
      date: ['created time', 'create time', 'fecha de creacion', 'time'],
    },
    feeAsset: 'crypto',
  },
  {
    // Encabezados reales: Order No.,Direction,Fiat Amount,Fiat Currency,Price,Fiat Currency,Coin Amount,Coin Type,
    //                     Transaction Fees,Counterparty,Status,Time (UTC-05:00)
    id: 'bybit-p2p', exchange: 'Bybit', filenameHint: /bybit/i, decimal: '.', idTime: 'snowflakeTwitter',
    signatures: [['order no', 'direction', 'fiat amount', 'coin amount'], ['order no', 'type', 'fiat amount', 'coin amount']],
    columns: {
      orderId: ['order no', 'order id', 'order number'],
      side: ['direction', 'type', 'side', 'order type'],
      crypto: ['coin type', 'cryptocurrency', 'coin', 'token', 'crypto'],
      fiat: ['fiat currency', 'fiat', 'currency'],
      amount: ['coin amount', 'quantity', 'crypto amount'],
      total: ['fiat amount', 'amount fiat'],
      price: ['price', 'unit price'],
      fee: ['transaction fees', 'transaction fee', 'fee', 'trading fee'],
      counterparty: ['counterparty', 'counterparty nickname'],
      status: ['status', 'order status'],
      date: ['time', 'order time', 'create time', 'created time', 'date'],
      payMethod: ['payment method', 'payment'],
    },
    feeAsset: 'crypto',
  },
  {
    // Encabezados reales: Order number,Time created,Order type,Crypto,Flat,Amount,Price,Quantity,status
    // "Amount" = monto FIAT, "Quantity" = cantidad cripto, "Flat" = moneda fiat. El N° de orden trae un TAB inicial.
    id: 'bitget-p2p', exchange: 'Bitget', filenameHint: /bitget/i, decimal: '.',
    signatures: [['order number', 'time created', 'order type', 'flat', 'quantity'], ['order no', 'coin', 'fiat', 'quantity', 'amount']],
    columns: {
      orderId: ['order number', 'order no', 'order id', 'numero de orden'],
      side: ['order type', 'type', 'side', 'tipo'],
      crypto: ['crypto', 'coin', 'moneda'],
      fiat: ['flat', 'fiat', 'fiat currency', 'moneda fiat'],
      amount: ['quantity', 'count', 'cantidad', 'coin quantity'],
      total: ['amount', 'total', 'order amount', 'fiat amount', 'monto'],
      price: ['price', 'precio', 'unit price'],
      fee: ['fee', 'comision', 'trading fee'],
      counterparty: ['counterparty', 'contraparte', 'nickname'],
      status: ['status', 'estado'],
      date: ['time created', 'time', 'created time', 'create time', 'order time', 'fecha'],
      payMethod: ['payment method', 'metodo de pago'],
    },
    feeAsset: 'crypto',
    noFeeColumnNote: 'La exportación de Bitget no incluye la comisión; se registró 0.',
  },
  {
    // Encabezados reales (español): N.º de orden,Tipo de orden,Criptomoneda,Moneda,Fuente de orden,Método de pago,Precio,
    //   Volumen,Monto,Estado,Contraparte,Fecha de creación,Fecha actualizada
    // "Volumen" = cantidad cripto, "Monto" = monto fiat, "Fuente de orden" NO es el exchange ("P2P Order").
    id: 'okx-p2p', exchange: 'OKX', filenameHint: /okx/i, decimal: '.', idTime: 'okxUtc8',
    signatures: [['n de orden', 'tipo de orden', 'criptomoneda', 'fuente de orden', 'volumen', 'monto'], ['order id', 'crypto amount', 'fiat amount']],
    columns: {
      orderId: ['n de orden', 'order id', 'order no', 'id de orden'],
      side: ['tipo de orden', 'side', 'type', 'order type'],
      crypto: ['criptomoneda', 'crypto', 'crypto currency', 'coin'],
      fiat: ['moneda', 'fiat', 'fiat currency', 'moneda fiat'],
      amount: ['volumen', 'crypto amount', 'quantity'],
      total: ['monto', 'fiat amount', 'total'],
      price: ['precio', 'unit price', 'price'],
      fee: ['comision', 'fee'],
      counterparty: ['contraparte', 'counterparty', 'nickname'],
      status: ['estado', 'status', 'state'],
      date: ['fecha de creacion', 'created at', 'create time', 'time', 'date'],
      payMethod: ['metodo de pago', 'payment method'],
    },
    feeAsset: 'crypto',
    noFeeColumnNote: 'La exportación de OKX no incluye la comisión; se registró 0.',
  },
  {
    // Encabezados reales (XLSX): ID de Transacción,Comerciante,Contraparte,Orden Creada,Orden Completada,Tipo de Orden,
    //   Criptomoneda,FIAT Usada,Cantidad de Cripto,Cantidad de FIAT,Tasa de Cambio,Comisión,Método de Pago
    // - No hay columna de estado: una orden con "Orden Completada" se considera completada; sin ella, desconocida.
    // - "Tasa de Cambio" viene redondeada a 2 decimales (hasta 0,4% de diferencia): el precio exacto es FIAT / Cripto.
    // - La comisión es ~0,25% de la cantidad cripto → está en la cripto (USDT).
    // - "Comerciante" es el nombre del anunciante, NO el exchange.
    id: 'eldorado-p2p', exchange: 'El Dorado', filenameHint: /dorado/i, idTime: 'uuidV7',
    signatures: [['id de transaccion', 'comerciante', 'cantidad de cripto', 'cantidad de fiat', 'tasa de cambio'], ['cantidad de cripto', 'cantidad de fiat']],
    columns: {
      orderId: ['id de transaccion', 'id', 'id de orden', 'orden'],
      side: ['tipo de orden', 'tipo', 'operacion'],
      crypto: ['criptomoneda', 'cripto', 'moneda cripto'],
      fiat: ['fiat usada', 'moneda fiat', 'fiat', 'moneda'],
      amount: ['cantidad de cripto', 'cantidad cripto'],
      total: ['cantidad de fiat', 'monto fiat', 'total fiat'],
      price: ['tasa de cambio', 'precio', 'tasa'],
      fee: ['comision', 'fee'],
      counterparty: ['contraparte', 'usuario'],
      status: ['estado', 'status'],
      date: ['orden creada', 'fecha de creacion', 'fecha'],
      completedAt: ['orden completada', 'fecha de completado'],
      payMethod: ['metodo de pago', 'medio de pago'],
    },
    feeAsset: 'crypto',
    statusFromCompletion: true,
    roundedPrice: true,
    payMethodMap: ELDORADO_PAY,
  },
];

// Perfil genérico: solo nombres INEQUÍVOCOS.
const GENERIC = {
  id: 'generico', exchange: null,
  columns: {
    orderId: ['order id', 'order no', 'order number', 'id de orden', 'numero de orden', 'n orden', 'n de orden'],
    side: ['side', 'tipo de operacion', 'tipo de orden', 'tipo', 'type', 'operacion', 'direction'],
    crypto: ['crypto', 'cripto', 'coin', 'asset', 'criptomoneda'],
    fiat: ['fiat', 'moneda fiat', 'fiat currency'],
    pair: ['pair', 'par', 'symbol', 'mercado'],
    amount: ['crypto amount', 'coin amount', 'cantidad cripto', 'cantidad de cripto'],
    total: ['fiat amount', 'total fiat', 'monto fiat', 'cantidad de fiat', 'total price'],
    price: ['price', 'precio', 'unit price', 'precio unitario'],
    fee: ['fee', 'comision', 'commission'],
    feeAsset: ['fee currency', 'fee asset', 'moneda comision', 'moneda de comision'],
    status: ['status', 'estado', 'state'],
    date: ['date', 'fecha', 'time', 'created time', 'fecha y hora', 'fecha de creacion'],
    counterparty: ['counterparty', 'contraparte'],
    payMethod: ['payment method', 'metodo de pago'],
    exchange: ['exchange', 'plataforma'],
  },
  feeAsset: null,
};
// Encabezados que existen en muchos exportes con significados distintos: nunca se mapean solos.
const AMBIGUOUS = new Set(['amount', 'cantidad', 'monto', 'quantity', 'total', 'importe', 'value', 'valor', 'volumen']);

/** Asigna columnas del encabezado a campos canónicos según un perfil. */
function mapHeaders(headers, profile) {
  const nh = headers.map(norm);
  // "Created Time (UTC+8)" / "Time (UTC-05:00)" → se comparan también sin el sufijo de zona
  const bare = nh.map((h) => h.replace(/\s*\b(utc|gmt)\b(\s*\d{1,2}(\s*\d{2})?)?$/, '').trim());
  const mapping = {};
  const used = new Set();
  for (const field of Object.keys(profile.columns)) {
    for (const alias of profile.columns[field]) {
      let idx = nh.findIndex((h, i) => h === alias && !used.has(i));
      if (idx < 0) idx = bare.findIndex((h, i) => h === alias && !used.has(i));
      if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
    }
  }
  return mapping;
}

function scoreProfile(headers, profile) {
  const nh = new Set(headers.map(norm).map((h) => h.replace(/\s*\b(utc|gmt)\b(\s*\d{1,2}(\s*\d{2})?)?$/, '').trim()));
  const sig = Math.max(...profile.signatures.map((s) => s.filter((x) => nh.has(x)).length / s.length));
  const mapped = Object.keys(mapHeaders(headers, profile)).length;
  return { sig, mapped };
}

module.exports = { PROFILES, GENERIC, AMBIGUOUS, FIELDS, REQUIRED, ID_TIME, norm, mapHeaders, scoreProfile };

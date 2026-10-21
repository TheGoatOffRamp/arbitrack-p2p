'use strict';
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const express = require('express');
const cors = require('cors');

const { Store } = require('./store');
const { Secrets, mask, deriveKey } = require('./secrets');
const { PgLedger, PgSecrets } = require('./db');
const { createAuth } = require('./auth');
const { createMailer } = require('./mailer');
const { mergeTrades, audit } = require('./ledger');
const { buildTrade, validateTrade, isCountable, present, canonicalExchange, slug, EDITABLE_FIELDS, STATUS, dedupKey } = require('./model');
const { rangeBoundary, DEFAULT_TZ, assertTz, toLocalMinute, parseSourceDate } = require('./dates');
const { D } = require('./money');
const { parseCsv, parseXlsx } = require('./importers/tabular');
const { parseXls, isXls } = require('./importers/xls');
const { analyze } = require('./importers/importer');
const { ADAPTERS, UNSUPPORTED } = require('./exchanges/adapters');
const { compute, toJSONSafe } = require('./accounting/engine');
const { buildWorkbook } = require('./accounting/excel');
const { buildPdf } = require('./accounting/pdf');
const { planClosing, verifyClosing, canReopen } = require('./accounting/closings');

const VERSION = '2.4.0';

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (msg, extra) => new HttpError(400, msg, extra);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function log(tag, msg) { if (process.env.NODE_ENV !== 'test') console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`); }

/**
 * Dos modos:
 * - local (sin `opts.pool`): un solo usuario, datos en archivos JSON, sin login (como v2.0).
 * - multiusuario (`opts.pool` = conexión PostgreSQL): cuentas con login; cada usuario solo ve sus datos.
 */
function createApp(opts = {}) {
  const pool = opts.pool || null;
  const multiUser = !!pool;
  const tz = opts.tz || DEFAULT_TZ;
  const http = { fetchImpl: opts.fetchImpl, sleepImpl: opts.sleepImpl, baseUrl: undefined, timeoutMs: opts.timeoutMs };

  let localStore = null, localSecrets = null, credentialKey = null;
  if (multiUser) {
    const secret = opts.secret ?? process.env.ARBITRACK_SECRET;
    if (!secret || secret.length < 32) throw new Error('En modo multiusuario ARBITRACK_SECRET es obligatorio (mínimo 32 caracteres): cifra las API keys de todos los usuarios.');
    credentialKey = deriveKey(secret);
  } else {
    const dataDir = opts.dataDir || process.env.ARBITRACK_DATA_DIR || path.join(__dirname, '..', 'data');
    localStore = new Store(dataDir);
    localSecrets = new Secrets(dataDir);
    localStore.load();
  }

  // Las rutas usan `store` y `secrets`; cada petición los resuelve al libro y credenciales de su usuario
  // (en modo local, los únicos que hay). Así ninguna ruta puede leer datos de otro usuario por descuido.
  const scope = new AsyncLocalStorage();
  const ctx = () => {
    const c = scope.getStore();
    if (!c) throw new Error('Petición sin usuario asociado');
    return c;
  };
  const store = { read: () => ctx().store.read(), mutate: (fn) => ctx().store.mutate(fn) };
  const secrets = {
    all: async () => ctx().secrets.all(),
    get: async (name) => ctx().secrets.get(name),
    set: async (name, cred) => ctx().secrets.set(name, cred),
    remove: async (name) => ctx().secrets.remove(name),
  };

  const app = express();
  app.disable('x-powered-by');
  // Cabeceras de seguridad. La interfaz usa scripts y estilos en línea, Google Fonts y Chart.js (cdnjs).
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
    ].join('; '));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (multiUser && process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (opts.trustProxy ?? process.env.ARBITRACK_TRUST_PROXY) app.set('trust proxy', Number(opts.trustProxy ?? process.env.ARBITRACK_TRUST_PROXY) || 1);

  const allowed = (process.env.ARBITRACK_CORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || origin === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || allowed.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  }));
  app.use(express.json({ limit: '30mb' }));

  if (multiUser) {
    // CSRF: además de SameSite=Lax, una petición que modifica datos debe venir de este mismo sitio.
    app.use('/api', (req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
      const origin = req.get('origin');
      if (!origin) return next();
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host === req.get('host') || allowed.includes(origin)) return next();
      return res.status(403).json({ error: 'Origen no permitido' });
    });
    const production = process.env.NODE_ENV === 'production';
    const publicUrl = (opts.publicUrl ?? process.env.ARBITRACK_PUBLIC_URL ?? '').replace(/\/+$/, '') || null;
    if (production && !publicUrl) throw new Error('En producción defina ARBITRACK_PUBLIC_URL (p. ej. https://arbitrack.pe): se usa en los enlaces de los emails.');
    const auth = createAuth({
      pool, HttpError, wrap, log, mailer: opts.mailer || createMailer({ log: (m) => log('MAIL', m) }), limits: opts.authLimits, publicUrl,
      secureCookies: opts.secureCookies ?? (production || process.env.ARBITRACK_SECURE_COOKIES === 'true'),
    });
    app.use('/api/v1/auth', auth.router);
    app.use('/api', auth.requireUser, wrap(async (req, res, next) => {
      const ledger = await new PgLedger(pool, req.user.id).load();
      scope.run({ store: ledger, secrets: new PgSecrets(pool, req.user.id, credentialKey) }, next);
    }));
  } else {
    const token = opts.token ?? process.env.ARBITRACK_TOKEN;
    if (token) {
      app.use('/api', (req, res, next) => {
        const got = req.get('x-arbitrack-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (got !== token) return res.status(401).json({ error: 'No autorizado' });
        next();
      });
    }
    app.get('/api/v1/auth/me', (req, res) => res.json({ mode: 'local', user: null }));
    app.use('/api', (req, res, next) => scope.run({ store: localStore, secrets: localSecrets }, next));
  }
  app.use(express.static(opts.publicDir || path.join(__dirname, '..', 'public')));

  // ── utilidades ──
  const period = (q) => {
    try {
      return { fromMs: rangeBoundary(q.from, 'start', tz) ?? undefined, toMs: rangeBoundary(q.to, 'end', tz) ?? undefined };
    } catch (e) { throw bad(e.message); }
  };
  // Alcance: 'todo' (historial completo, por defecto), 'actual' (lo no cerrado) o el id de un ciclo cerrado.
  const scopeOf = (q, s = store.read()) => {
    const sc = q.scope || 'todo';
    if (sc !== 'todo' && sc !== 'actual' && !(s.closings || []).some((k) => k.id === sc)) throw bad(`Alcance desconocido: ${sc}`);
    return sc;
  };
  const report = (q = {}) => {
    const s = store.read();
    const scope = scopeOf(q, s);
    // Un ciclo cerrado se calcula completo: el período no aplica.
    return compute(s, { ...(scope === 'todo' || scope === 'actual' ? period(q) : {}), tz, scope });
  };
  const findTrade = (s, id) => s.trades.find((t) => t.id === id);
  const manualClosed = (s, cycleId) => s.trades.some((t) => t.cycleId === cycleId && t.closingId);
  const closingOf = (s, id) => (s.closings || []).find((k) => k.id === id);
  const locked = (s, rec, what = 'La operación') => {
    if (!rec?.closingId) return;
    const k = closingOf(s, rec.closingId);
    throw new HttpError(409, `${what} pertenece al ciclo cerrado ${k ? `#${k.seq} de ${k.pair}` : rec.closingId}. Reábrelo para modificarla.`);
  };

  // ── salud ──
  app.get('/health', (req, res) => {
    const base = { status: 'ok', version: VERSION, timestamp: new Date().toISOString(), tz, mode: multiUser ? 'multiuser' : 'local' };
    if (multiUser) return res.json(base);
    res.json({ ...base, trades: localStore.read().trades.filter((t) => !t.deleted).length, credentialKey: localSecrets.keySource });
  });

  // ── credenciales ──
  app.post('/api/v1/exchange/connect', wrap(async (req, res) => {
    const { exchange, apiKey, apiSecret, passphrase } = req.body || {};
    if (!exchange || !apiKey || !apiSecret) throw bad('Faltan campos: exchange, apiKey y apiSecret son obligatorios');
    const k = slug(canonicalExchange(exchange));
    if (UNSUPPORTED[k]) throw bad(UNSUPPORTED[k]);
    if (!ADAPTERS[k]) throw bad(`Exchange "${exchange}" no soportado para sincronización por API`);
    if (k === 'bitget' && !passphrase) throw bad('Bitget requiere passphrase');
    await secrets.set(k, { apiKey: String(apiKey).trim(), apiSecret: String(apiSecret).trim(), passphrase: passphrase ? String(passphrase) : undefined, connectedAt: new Date().toISOString() });
    log('CONNECT', `${k} conectado (${mask(apiKey)})`);
    res.json({ success: true, exchange: k });
  }));
  app.delete('/api/v1/exchange/:exchange', wrap(async (req, res) => {
    await secrets.remove(slug(canonicalExchange(req.params.exchange)));
    res.json({ success: true });
  }));
  app.get('/api/v1/exchanges', wrap(async (req, res) => {
    res.json({ exchanges: Object.entries(await secrets.all()).map(([name, d]) => ({ name, connectedAt: d.connectedAt, apiKey: mask(d.apiKey) })) });
  }));

  // ── sincronización (todo o nada) ──
  app.post('/api/v1/sync/:exchange', wrap(async (req, res) => {
    const k = slug(canonicalExchange(req.params.exchange));
    if (UNSUPPORTED[k]) return res.status(400).json({ success: false, exchange: k, error: UNSUPPORTED[k] });
    const adapter = ADAPTERS[k];
    if (!adapter) throw bad(`Exchange ${req.params.exchange} no soportado`);
    const cred = await secrets.get(k);
    if (!cred) throw bad(`${k} no está conectado`);
    const { startDate, endDate, allowPartial } = req.body || {};
    const startMs = startDate ? rangeBoundary(startDate, 'start', tz) : Date.now() - 7 * 86400000;
    const endMs = endDate ? rangeBoundary(endDate, 'end', tz) : Date.now();
    if (!(startMs < endMs)) throw bad('Rango de fechas inválido (inicio ≥ fin)');
    const dateRange = { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
    log('SYNC', `${k} ${dateRange.start} → ${dateRange.end}`);

    let fetched;
    try {
      fetched = await adapter(cred, startMs, endMs, { ...http, baseUrl: opts.baseUrls?.[k] });
    } catch (e) {
      log('SYNC', `${k} falló: ${e.message}`);
      return res.status(502).json({ success: false, exchange: k, error: `${e.message}. No se guardó ningún dato de esta sincronización.`, dateRange });
    }
    const built = [], rejected = [];
    for (const c of fetched.candidates) {
      const r = buildTrade(c, { source: 'api', tz, decimal: '.', sourceRef: { api: k } });
      if (r.rejected) rejected.push({ orderId: c.orderId, reasons: r.rejected.reasons }); else built.push(r.trade);
    }
    const problems = [...fetched.schemaErrors, ...rejected.map((x) => `orden ${x.orderId}: ${x.reasons.join('; ')}`)];
    if (problems.length && !allowPartial) {
      return res.status(422).json({ success: false, exchange: k, error: `La API devolvió ${problems.length} registro(s) con estructura inesperada. No se guardó nada.`, problems: problems.slice(0, 50), dateRange });
    }
    const batchId = `api-${k}-${Date.now()}`;
    const rep = await store.mutate((s) => {
      const r = mergeTrades(s, built, { batchId, origin: `api:${k}` });
      s.batches.push({ id: batchId, kind: 'api', exchange: k, at: new Date().toISOString(), range: dateRange, fetched: fetched.candidates.length,
        inserted: r.inserted.length, updated: r.updated.length, unchanged: r.unchanged.length, rejected: problems.length });
      return r;
    });
    const s = store.read();
    res.json({
      success: true, exchange: k, batchId, dateRange,
      totalFound: fetched.candidates.length, newImported: rep.inserted.length, updated: rep.updated.length, unchanged: rep.unchanged.length,
      duplicatesInResponse: rep.duplicatesInBatch.length, conflicts: rep.conflicts, problems,
      trades: rep.inserted.map((id) => present(findTrade(s, id))),
      statusChanges: rep.updated.filter((u) => u.changes.some((c) => c.field === 'status')),
    });
  }));

  // ── operaciones ──
  app.get('/api/v1/trades', (req, res) => {
    const { exchange, type, status, pair, includeDeleted } = req.query;
    const { fromMs, toMs } = period(req.query);
    const rep = report();
    let f = store.read().trades.filter((t) => includeDeleted === 'true' || !t.deleted);
    if (fromMs !== undefined) f = f.filter((t) => Date.parse(t.dateUtc) >= fromMs);
    if (toMs !== undefined) f = f.filter((t) => Date.parse(t.dateUtc) < toMs);
    if (exchange) f = f.filter((t) => slug(t.exchange) === slug(canonicalExchange(exchange)));
    if (type) f = f.filter((t) => t.type === type || t.side === type);
    if (status) f = f.filter((t) => t.status === status);
    if (pair) f = f.filter((t) => t.pair === String(pair).toUpperCase());
    f = [...f].sort((a, b) => b.dateUtc.localeCompare(a.dateUtc));
    res.json({ total: f.length, trades: f.map((t) => {
      const info = rep.tradeInfo.get(t.id);
      return { ...present(t), countable: !!info?.countable, excludedReason: info?.excluded || null, issues: validateTrade(t),
        cycle: t.side === 'sell' ? info?.cycleRef || null : [...new Set(info?.cycleRefs || [])] };
    }) });
  });

  app.get('/api/v1/trades/:id/trace', (req, res) => {
    const s = store.read();
    const t = findTrade(s, req.params.id);
    if (!t) throw new HttpError(404, 'Operación no encontrada');
    const rep = report();
    const info = rep.tradeInfo.get(t.id);
    res.json(toJSONSafe({
      trade: t, countable: !!info?.countable, excludedReason: info?.excluded || null, issues: validateTrade(t),
      cycles: rep.cycles.filter((c) => c.buyTradeIds.includes(t.id) || c.sellTradeIds.includes(t.id)),
      allocations: rep.allocations.filter((a) => a.buyId === t.id || a.sellId === t.id),
      batches: (t.batchIds || []).map((id) => s.batches.find((b) => b.id === id)).filter(Boolean),
    }));
  });

  // Entrada manual con los campos de la webapp (type, date local, feeType, feePercent…)
  const manualCandidate = (b, base = {}) => {
    const m = { ...base, ...b };
    let fee = m.fee;
    const feeAsset = b.feeAsset
      || (b.feeType === 'fiat' ? m.fiat : b.feeType === 'crypto' ? m.crypto : null)
      || (base.feeAsset && (base.feeAsset === base.crypto ? m.crypto : m.fiat))
      || m.crypto;
    const derived = [];
    if ((fee === undefined || fee === null || fee === '' || Number(fee) === 0) && Number(m.feePercent) > 0) {
      const baseAmt = feeAsset === m.fiat ? m.total : m.amount;
      fee = D(baseAmt || 0).times(m.feePercent).div(100).toFixed();
      derived.push(`comisión = ${m.feePercent}% de ${feeAsset === m.fiat ? 'total' : 'cantidad'}`);
    }
    const dateField = b.dateUtc ? { dateUtc: b.dateUtc } : b.date ? { date: b.date } : base.dateUtc ? { dateUtc: base.dateUtc } : {};
    return { cand: { exchange: m.exchange, orderId: m.orderId, side: b.side || b.type || base.side, crypto: m.crypto, fiat: m.fiat,
      amount: m.amount, price: m.price, total: m.total, fee, feeAsset, status: m.status, ...dateField,
      counterparty: m.counterparty, payMethod: m.payMethod, notes: m.notes, cycleId: m.cycleId, raw: base.raw ?? null }, derived };
  };

  const createManual = async (body) => {
    const { cand, derived } = manualCandidate(body);
    const r = buildTrade(cand, { source: 'manual', tz, decimal: '.' });
    if (r.rejected) throw bad(`Operación inválida: ${r.rejected.reasons.join('; ')}`, { reasons: r.rejected.reasons });
    r.trade.derived.push(...derived);
    if (!r.trade.orderId) r.trade.id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    return store.mutate((s) => {
      if (s.trades.some((t) => !t.deleted && t.dedupKey === r.trade.dedupKey)) {
        throw new HttpError(409, `Ya existe una operación con la misma orden (${r.trade.orderId || 'misma huella'}) en ${r.trade.exchange}.`);
      }
      const batchId = `manual-${Date.now()}`;
      const rep = mergeTrades(s, [r.trade], { batchId, origin: 'manual' });
      return findTrade(s, rep.inserted[0]);
    });
  };

  const updateTrade = async (id, body) => store.mutate((s) => {
    const t = findTrade(s, id);
    if (!t) throw new HttpError(404, 'Operación no encontrada');
    locked(s, t);
    const changes = Object.fromEntries(Object.entries(body || {}).filter(([k]) => EDITABLE_FIELDS.includes(k) || ['feeType', 'feePercent'].includes(k)));
    if (changes.cycleId) {
      const c = s.cycles.find((x) => x.id === changes.cycleId);
      if (!c) throw bad(`El ciclo ${changes.cycleId} no existe`);
    }
    const { cand, derived } = manualCandidate(changes, t);
    const r = buildTrade(cand, { source: t.source, tz, decimal: '.', sourceRef: t.sourceRef });
    if (r.rejected) throw bad(`Cambio inválido: ${r.rejected.reasons.join('; ')}`);
    const next = r.trade;
    if (next.cycleId) {
      const c = s.cycles.find((x) => x.id === next.cycleId);
      if (c.pair !== next.pair) throw bad(`No se puede asignar una operación ${next.pair} al ciclo "${c.name}" (${c.pair}).`);
    }
    if (next.dedupKey !== t.dedupKey && s.trades.some((x) => x !== t && !x.deleted && x.dedupKey === next.dedupKey)) {
      throw new HttpError(409, 'El cambio la convertiría en duplicado de otra operación existente.');
    }
    const diff = [];
    for (const f of ['side', 'type', 'exchange', 'orderId', 'crypto', 'fiat', 'pair', 'amount', 'price', 'total', 'fee', 'feeAsset', 'status', 'dateUtc', 'date', 'counterparty', 'payMethod', 'notes', 'cycleId']) {
      const same = ['amount', 'price', 'total', 'fee'].includes(f) ? D(t[f] || 0).eq(D(next[f] || 0)) : (t[f] ?? null) === (next[f] ?? null);
      if (!same) diff.push({ field: f, from: t[f] ?? null, to: next[f] ?? null });
    }
    if (!diff.length) return t;
    const now = new Date().toISOString();
    for (const d of diff) {
      t[d.field] = d.to;
      if (!['notes', 'cycleId'].includes(d.field) && !t.manualFields.includes(d.field)) t.manualFields.push(d.field);
    }
    t.dedupKey = next.dedupKey;
    t.derived = [...new Set([...(next.derived || []), ...derived])];
    t.updatedAt = now;
    t.history.push({ at: now, by: 'usuario', changes: diff });
    audit(s, { action: 'edit', tradeId: t.id, fields: diff.map((d) => d.field) });
    return t;
  });

  app.post('/api/v1/trades', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.id && findTrade(store.read(), b.id)) return res.json({ success: true, trade: present(await updateTrade(b.id, b)) });
    res.json({ success: true, trade: present(await createManual(b)) });
  }));
  const updateHandler = wrap(async (req, res) => res.json({ success: true, trade: present(await updateTrade(req.params.id, req.body)) }));
  app.put('/api/v1/trades/:id', updateHandler);
  app.post('/api/v1/trades/:id', updateHandler);

  app.delete('/api/v1/trades/:id', wrap(async (req, res) => {
    await store.mutate((s) => {
      const t = findTrade(s, req.params.id);
      if (!t) throw new HttpError(404, 'Operación no encontrada');
      if (t.deleted) return;
      locked(s, t);
      t.deleted = true; t.updatedAt = new Date().toISOString();
      t.history.push({ at: t.updatedAt, by: 'usuario', changes: [{ field: 'deleted', from: false, to: true }], reason: (req.body || {}).reason || null });
      audit(s, { action: 'delete', tradeId: t.id });
    });
    res.json({ success: true });
  }));
  app.post('/api/v1/trades/:id/restore', wrap(async (req, res) => {
    await store.mutate((s) => {
      const t = findTrade(s, req.params.id);
      if (!t) throw new HttpError(404, 'Operación no encontrada');
      if (s.trades.some((x) => x !== t && !x.deleted && x.dedupKey === t.dedupKey)) throw new HttpError(409, 'Ya existe otra operación activa equivalente.');
      t.deleted = false; t.updatedAt = new Date().toISOString();
      t.history.push({ at: t.updatedAt, by: 'usuario', changes: [{ field: 'deleted', from: true, to: false }] });
    });
    res.json({ success: true });
  }));

  // ── importación ──
  const readRows = async (b) => {
    const name = b.filename || 'archivo';
    if (b.contentBase64) {
      const buf = Buffer.from(b.contentBase64, 'base64');
      if (/\.xlsx$/i.test(name) || buf.slice(0, 2).toString() === 'PK') return (await parseXlsx(buf)).rows;
      if (isXls(buf)) return parseXls(buf).rows;
      return parseCsv(buf.toString('utf8')).rows;
    }
    if (typeof b.content === 'string') return parseCsv(b.content, b.delimiter).rows;
    if (Array.isArray(b.rows)) return b.rows;
    throw bad('Envíe el archivo en "content" (texto CSV) o "contentBase64" (CSV/XLSX)');
  };

  app.post('/api/v1/import/file', wrap(async (req, res) => {
    const b = req.body || {};
    if (b.tz) { try { assertTz(b.tz); } catch (e) { throw bad(e.message); } }
    let rows;
    try { rows = await readRows(b); } catch (e) { if (e instanceof HttpError) throw e; throw bad(`No se pudo leer el archivo: ${e.message}`); }
    const a = analyze(rows, { filename: b.filename, exchange: b.exchange, mapping: b.mapping, tz: b.tz, dateOrder: b.dateOrder, decimal: b.decimal, onlyPairs: b.onlyPairs });
    const out = {
      status: a.status, detection: a.detection, mapping: a.mapping, options: a.options, needs: a.needs, blocking: a.blocking,
      warnings: a.warnings, summary: a.summary, rejected: a.rejected, issues: a.issues, filteredByPair: a.filtered.length,
      preview: a.trades.slice(0, 25).map(present), committed: false,
    };
    if (!b.commit) return res.json(out);
    if (a.status === 'error' || a.status === 'needs_input') {
      return res.status(422).json({ ...out, error: 'La importación no se registró: resuelva los puntos indicados en "blocking"/"needs".' });
    }
    if (!a.trades.length) return res.status(422).json({ ...out, error: 'No hay operaciones válidas para registrar.' });
    const batchId = `csv-${Date.now()}`;
    const rep = await store.mutate((s) => {
      const r = mergeTrades(s, a.trades, { batchId, origin: `archivo:${b.filename || ''}` });
      for (const x of a.rejected) s.quarantine.push({ at: new Date().toISOString(), origin: batchId, row: x.row, reasons: x.reasons, raw: x.raw });
      s.batches.push({ id: batchId, kind: 'file', file: b.filename || null, profile: a.detection.profile, exchange: a.detection.exchange,
        options: a.options, mapping: a.mapping, at: new Date().toISOString(), rows: a.summary.dataRows, inserted: r.inserted.length,
        updated: r.updated.length, unchanged: r.unchanged.length, duplicatesInFile: r.duplicatesInBatch.length, rejected: a.rejected.length });
      return r;
    });
    log('IMPORT', `${b.filename}: +${rep.inserted.length} / ~${rep.updated.length} / =${rep.unchanged.length} / rechazadas ${a.rejected.length}`);
    res.json({ ...out, committed: true, batchId, result: {
      inserted: rep.inserted.length, updated: rep.updated, unchanged: rep.unchanged.length,
      duplicatesInFile: rep.duplicatesInBatch, skipped: rep.skipped, conflicts: rep.conflicts } });
  }));

  // Importación heredada: la webapp envía operaciones ya parseadas. Pasan por la misma normalización (sin valores por defecto silenciosos).
  app.post('/api/v1/import', wrap(async (req, res) => {
    const list = (req.body || {}).trades;
    if (!Array.isArray(list) || !list.length) throw bad('No se encontraron operaciones');
    const good = [], rejected = [];
    list.forEach((t, i) => {
      const feeAsset = t.feeAsset || (t.feeType === 'fiat' ? t.fiat : t.crypto);
      const r = buildTrade({ exchange: t.exchange, orderId: t.orderId, side: t.side || t.type, crypto: t.crypto, fiat: t.fiat,
        amount: t.amount, price: t.price, total: t.total, fee: t.fee, feeAsset, status: t.status, date: t.date, dateUtc: t.dateUtc,
        counterparty: t.counterparty, payMethod: t.payMethod, notes: t.notes, raw: t }, { source: 'csv', tz, decimal: '.', sourceRef: { legacyImport: true, row: i + 1 } });
      if (r.rejected) rejected.push({ row: i + 1, reasons: r.rejected.reasons }); else good.push(r.trade);
    });
    const batchId = `import-${Date.now()}`;
    const rep = good.length ? await store.mutate((s) => {
      const r = mergeTrades(s, good, { batchId, origin: 'import-webapp' });
      s.batches.push({ id: batchId, kind: 'legacy-import', at: new Date().toISOString(), rows: list.length, inserted: r.inserted.length, updated: r.updated.length, rejected: rejected.length });
      return r;
    }) : { inserted: [], updated: [], unchanged: [], duplicatesInBatch: [] };
    res.json({ success: true, imported: rep.inserted.length, updated: rep.updated.length, unchanged: rep.unchanged.length,
      duplicates: rep.duplicatesInBatch.length, rejected, total: store.read().trades.filter((t) => !t.deleted).length });
  }));

  app.get('/api/v1/import/batches', (req, res) => res.json({ batches: [...store.read().batches].reverse() }));
  app.get('/api/v1/import/quarantine', (req, res) => res.json({ rows: store.read().quarantine }));
  // Deshacer un lote: marca como eliminadas las operaciones que SOLO provienen de ese lote.
  app.delete('/api/v1/import/batches/:id', wrap(async (req, res) => {
    const n = await store.mutate((s) => {
      const b = s.batches.find((x) => x.id === req.params.id);
      if (!b) throw new HttpError(404, 'Lote no encontrado');
      let count = 0;
      const now = new Date().toISOString();
      for (const t of s.trades) {
        if (!t.deleted && !t.closingId && t.batchIds?.length === 1 && t.batchIds[0] === b.id) {
          t.deleted = true; t.updatedAt = now; t.history.push({ at: now, by: 'usuario', changes: [{ field: 'deleted', from: false, to: true }], reason: `deshacer lote ${b.id}` });
          count++;
        }
      }
      b.undoneAt = now;
      audit(s, { action: 'undo-batch', batchId: b.id, trades: count });
      return count;
    });
    res.json({ success: true, removed: n });
  }));

  // ── ciclos manuales ──
  app.get('/api/v1/cycles', (req, res) => {
    const rep = report(req.query);
    res.json(toJSONSafe({ manual: store.read().cycles, results: rep.cycles }));
  });
  app.post('/api/v1/cycles', wrap(async (req, res) => {
    const { name, pair, tradeIds = [], notes } = req.body || {};
    const p = String(pair || '').toUpperCase();
    if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(p)) throw bad('El par debe tener formato BASE/COTIZADA, p. ej. USDT/PEN');
    const c = await store.mutate((s) => {
      const id = `M-${Date.now().toString(36).toUpperCase()}`;
      const cycle = { id, name: name || id, pair: p, notes: notes || null, createdAt: new Date().toISOString() };
      s.cycles.push(cycle);
      assignTrades(s, cycle, tradeIds);
      return cycle;
    });
    res.json({ success: true, cycle: c });
  }));
  const assignTrades = (s, cycle, ids) => {
    if (manualClosed(s, cycle.id)) throw new HttpError(409, `El ciclo "${cycle.name}" ya está dentro de un ciclo cerrado; no admite operaciones nuevas.`);
    const errors = [];
    for (const id of ids) {
      const t = findTrade(s, id);
      if (!t || t.deleted) { errors.push(`${id}: no existe`); continue; }
      if (t.closingId) { errors.push(`${id}: pertenece a un ciclo cerrado`); continue; }
      if (t.pair !== cycle.pair) { errors.push(`${id}: es ${t.pair}, el ciclo es ${cycle.pair}`); continue; }
      if (t.cycleId && t.cycleId !== cycle.id) { errors.push(`${id}: ya pertenece al ciclo ${t.cycleId}`); continue; }
    }
    if (errors.length) throw bad(`No se asignó ninguna operación: ${errors.join('; ')}`, { errors });
    const now = new Date().toISOString();
    for (const id of ids) {
      const t = findTrade(s, id);
      if (t.cycleId === cycle.id) continue;
      t.history.push({ at: now, by: 'usuario', changes: [{ field: 'cycleId', from: t.cycleId, to: cycle.id }] });
      t.cycleId = cycle.id; t.updatedAt = now;
    }
  };
  app.post('/api/v1/cycles/:id/trades', wrap(async (req, res) => {
    await store.mutate((s) => {
      const c = s.cycles.find((x) => x.id === req.params.id);
      if (!c) throw new HttpError(404, 'Ciclo no encontrado');
      assignTrades(s, c, (req.body || {}).tradeIds || []);
    });
    res.json({ success: true });
  }));
  app.delete('/api/v1/cycles/:id/trades/:tradeId', wrap(async (req, res) => {
    await store.mutate((s) => {
      const t = findTrade(s, req.params.tradeId);
      if (!t || t.cycleId !== req.params.id) throw new HttpError(404, 'La operación no está en ese ciclo');
      locked(s, t);
      t.history.push({ at: new Date().toISOString(), by: 'usuario', changes: [{ field: 'cycleId', from: t.cycleId, to: null }] });
      t.cycleId = null;
    });
    res.json({ success: true });
  }));
  app.delete('/api/v1/cycles/:id', wrap(async (req, res) => {
    await store.mutate((s) => {
      const i = s.cycles.findIndex((x) => x.id === req.params.id);
      if (i < 0) throw new HttpError(404, 'Ciclo no encontrado');
      for (const t of s.trades) if (t.cycleId === req.params.id) locked(s, t, 'Una operación de este ciclo manual');
      for (const t of s.trades) if (t.cycleId === req.params.id) { t.history.push({ at: new Date().toISOString(), by: 'usuario', changes: [{ field: 'cycleId', from: t.cycleId, to: null }] }); t.cycleId = null; }
      for (const c of s.costs) if (c.cycleId === req.params.id) c.cycleId = null;
      s.cycles.splice(i, 1);
    });
    res.json({ success: true });
  }));

  // ── otros costos ──
  app.get('/api/v1/costs', (req, res) => res.json({ costs: store.read().costs.filter((c) => !c.deleted) }));
  app.post('/api/v1/costs', wrap(async (req, res) => {
    const { date, dateUtc, pair, asset, amount, description, exchange, cycleId } = req.body || {};
    const p = String(pair || '').toUpperCase();
    const [cr, fi] = p.split('/');
    if (!cr || !fi) throw bad('Par inválido (use BASE/COTIZADA)');
    const a = String(asset || '').toUpperCase();
    if (a !== cr && a !== fi) throw bad(`La moneda del costo (${a || 'vacía'}) debe ser ${cr} o ${fi}`);
    if (!(D(amount || 0).gt(0))) throw bad('El monto del costo debe ser mayor que 0');
    if (!description) throw bad('Describa el costo (p. ej. "comisión de red TRC20")');
    const pd = dateUtc ? parseSourceDate(dateUtc, { tz: 'UTC' }) : parseSourceDate(date, { tz });
    if (!pd.ok) throw bad(`Fecha: ${pd.error}`);
    const cost = await store.mutate((s) => {
      if (cycleId) {
        const c = s.cycles.find((x) => x.id === cycleId);
        if (!c) throw bad(`El ciclo ${cycleId} no existe`);
        if (c.pair !== p) throw bad(`El costo es de ${p} y el ciclo es ${c.pair}`);
        if (manualClosed(s, cycleId)) throw new HttpError(409, `El ciclo "${c.name}" ya está dentro de un ciclo cerrado; no admite costos nuevos.`);
      }
      const rec = { id: `cost_${Date.now().toString(36)}`, dateUtc: new Date(pd.ms).toISOString(), date: toLocalMinute(pd.ms, tz), pair: p, asset: a,
        amount: D(amount).toFixed(), description: String(description), exchange: exchange ? canonicalExchange(exchange) : null, cycleId: cycleId || null, createdAt: new Date().toISOString() };
      s.costs.push(rec);
      return rec;
    });
    res.json({ success: true, cost });
  }));
  app.delete('/api/v1/costs/:id', wrap(async (req, res) => {
    await store.mutate((s) => {
      const c = s.costs.find((x) => x.id === req.params.id);
      if (!c) throw new HttpError(404, 'Costo no encontrado');
      locked(s, c, 'El costo');
      c.deleted = true;
    });
    res.json({ success: true });
  }));

  // ── ciclos cerrados ──
  const presentClosing = (s, k) => ({ ...k, carryLots: undefined, carriedQty: (k.carryLots || []).reduce((a, l) => a.plus(l.qty), D(0)).toFixed(),
    intact: verifyClosing(s, k, tz), canReopen: canReopen(s, k) });
  const parseCutoff = (v) => {
    if (!v) return new Date().toISOString();
    const pd = parseSourceDate(v, { tz });
    if (!pd.ok) throw bad(`Fecha de corte: ${pd.error}`);
    return new Date(pd.ms).toISOString();
  };
  const closingInput = (b) => {
    const pair = String(b.pair || '').toUpperCase();
    if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(pair)) throw bad('Indica el par a cerrar, p. ej. USDT/PEN');
    return { pair, cutoffUtc: parseCutoff(b.cutoff), carry: b.carry !== false && b.carry !== 'false' };
  };
  const plan = (s, input) => { try { return planClosing(s, { ...input, tz }); } catch (e) { throw bad(e.message); } };

  app.get('/api/v1/closings', (req, res) => {
    const s = store.read();
    res.json({ closings: [...(s.closings || [])].sort((a, b) => b.cutoffUtc.localeCompare(a.cutoffUtc)).map((k) => presentClosing(s, k)) });
  });
  // Vista previa: qué quedaría congelado, sin guardar nada.
  app.get('/api/v1/closings/preview', (req, res) => {
    const input = closingInput(req.query);
    const r = plan(store.read(), input);
    res.json({ pair: input.pair, cutoffUtc: input.cutoffUtc, cutoffLocal: toLocalMinute(Date.parse(input.cutoffUtc), tz).replace('T', ' '), seq: r.seq,
      trades: r.tradeIds.length, costs: r.costIds.length, pending: r.pending, firstUtc: r.firstUtc, summary: r.summary,
      carriedQty: r.carryLots.reduce((a, l) => a.plus(l.qty), D(0)).toFixed() });
  });
  app.post('/api/v1/closings', wrap(async (req, res) => {
    const b = req.body || {};
    const input = closingInput(b);
    const k = await store.mutate((s) => {
      const r = plan(s, input);
      const now = new Date().toISOString();
      const rec = { id: r.id, seq: r.seq, pair: input.pair, name: String(b.name || '').trim().slice(0, 80) || `${input.pair} · Ciclo #${r.seq}`,
        notes: b.notes ? String(b.notes).slice(0, 500) : null, cutoffUtc: input.cutoffUtc, cutoffLocal: toLocalMinute(Date.parse(input.cutoffUtc), tz).replace('T', ' '),
        firstUtc: r.firstUtc, createdAt: now, carry: input.carry, tradeCount: r.tradeIds.length, costCount: r.costIds.length,
        summary: r.summary, carryLots: r.carryLots };
      const ids = new Set(r.tradeIds), cids = new Set(r.costIds);
      for (const t of s.trades) if (ids.has(t.id)) { t.closingId = rec.id; t.history.push({ at: now, by: 'usuario', changes: [{ field: 'closingId', from: null, to: rec.id }] }); }
      for (const c of s.costs) if (cids.has(c.id)) c.closingId = rec.id;
      s.closings = [...(s.closings || []), rec];
      audit(s, { action: 'close-cycle', closingId: rec.id, pair: rec.pair, cutoffUtc: rec.cutoffUtc, trades: rec.tradeCount, net: rec.summary.net });
      return rec;
    });
    log('CLOSE', `${k.pair} #${k.seq} hasta ${k.cutoffUtc}: ${k.tradeCount} operaciones`);
    res.status(201).json({ success: true, closing: presentClosing(store.read(), k) });
  }));
  // Reabrir: las operaciones vuelven al ciclo actual tal como estaban. Solo el último cierre de cada par.
  app.delete('/api/v1/closings/:id', wrap(async (req, res) => {
    const n = await store.mutate((s) => {
      const k = closingOf(s, req.params.id);
      if (!k) throw new HttpError(404, 'Ciclo cerrado no encontrado');
      if (!canReopen(s, k)) throw new HttpError(409, `Primero reabre los ciclos posteriores de ${k.pair}; este es el #${k.seq}.`);
      const now = new Date().toISOString();
      let count = 0;
      for (const t of s.trades) if (t.closingId === k.id) { t.closingId = null; t.history.push({ at: now, by: 'usuario', changes: [{ field: 'closingId', from: k.id, to: null }] }); count++; }
      for (const c of s.costs) if (c.closingId === k.id) c.closingId = null;
      s.closings = s.closings.filter((x) => x.id !== k.id);
      audit(s, { action: 'reopen-cycle', closingId: k.id, pair: k.pair, trades: count });
      return count;
    });
    res.json({ success: true, reopened: n });
  }));

  // ── reportes ──
  app.get('/api/v1/report', (req, res) => {
    const rep = report(req.query);
    const { tradeInfo, ...rest } = rep;
    res.json(toJSONSafe(rest));
  });
  app.get('/api/v1/issues', (req, res) => {
    const rep = report(req.query);
    const sev = req.query.severity;
    res.json({ issues: sev ? rep.issues.filter((i) => i.severity === sev) : rep.issues });
  });

  // Estadísticas: por par. Los campos heredados (profit, volBuy…) corresponden a UN par, nunca a una mezcla de monedas.
  app.get('/api/v1/stats', (req, res) => {
    const rep = report(req.query);
    const byPair = rep.pairs.map((p) => ({
      pair: p.pair, crypto: p.crypto, fiat: p.fiat, buys: p.buys.count, sells: p.sells.count,
      volBuy: p.buys.fiat, volSell: p.sells.fiat, qtyBuy: p.buys.qty, qtySell: p.sells.qty,
      grossProfit: p.gross, fees: p.fees, otherCosts: p.otherCosts, netProfit: p.net, costOfSales: p.costOfSales,
      roi: p.costOfSales.gt(0) ? p.net.div(p.costOfSales).times(100) : 0, inventoryQty: p.closingInventory.qty, inventoryCost: p.closingInventory.cost, cycles: p.cycles,
    }));
    const wanted = req.query.pair ? String(req.query.pair).toUpperCase() : null;
    const main = wanted ? byPair.find((p) => p.pair === wanted) : [...byPair].sort((a, b) => (b.buys + b.sells) - (a.buys + a.sells))[0];
    const counted = [...rep.tradeInfo.values()].filter((i) => i.countable).length;
    const num = (v) => Number(D(v || 0).toFixed());
    res.json(toJSONSafe({
      pair: main?.pair || null,
      warning: byPair.length > 1 ? `Hay ${byPair.length} pares; los campos principales corresponden a ${main.pair}. Use "byPair" para el resto (no se suman monedas distintas).` : null,
      totalTrades: counted, buys: main?.buys || 0, sells: main?.sells || 0,
      profit: num(main?.netProfit), grossProfit: num(main?.grossProfit), volBuy: num(main?.volBuy), volSell: num(main?.volSell),
      volume: num(D(main?.volBuy || 0).plus(main?.volSell || 0)), fees: num(main?.fees), roi: num(main?.roi),
      byPair, excluded: rep.tradeInfo.size - counted,
      issues: { error: rep.issues.filter((i) => i.severity === 'error').length, warning: rep.issues.filter((i) => i.severity === 'warning').length },
    }));
  });

  // Etiquetas del archivo según el alcance (un ciclo cerrado lleva su propio rango y nombre).
  const exportCtx = (q) => {
    const today = new Date().toISOString().slice(0, 10);
    const k = closingOf(store.read(), q.scope);
    if (k) {
      return { fromLabel: k.firstUtc ? toLocalMinute(Date.parse(k.firstUtc), tz).slice(0, 10) : null, toLabel: k.cutoffLocal,
        scopeLabel: `${k.name} (cerrado, hasta ${k.cutoffLocal})`, fileTag: `${k.pair.replace('/', '-')}_ciclo-${k.seq}` };
    }
    const scopeLabel = q.scope === 'actual' ? 'Solo el ciclo actual (sin ciclos cerrados)' : null;
    return { fromLabel: q.from, toLabel: q.to, scopeLabel,
      fileTag: `${q.scope === 'actual' ? 'ciclo-actual_' : ''}${String(q.from || 'inicio').slice(0, 10)}_${String(q.to || today).slice(0, 10)}` };
  };
  const scopedTrades = (q) => {
    const sc = q.scope || 'todo';
    return store.read().trades.filter((t) => sc === 'todo' || (sc === 'actual' ? !t.closingId : t.closingId === sc));
  };
  const exportExcel = wrap(async (req, res) => {
    const q = { ...req.query, ...(req.body || {}) };
    const rep = report(q);
    const x = exportCtx(q);
    const wb = await buildWorkbook(rep, { trades: scopedTrades(q), userName: q.userName, ...x });
    const fname = `ArbiTrack_${x.fileTag}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    const buf = await wb.xlsx.writeBuffer();
    res.end(Buffer.from(buf));
    log('EXPORT', `${fname}: ${rep.cycles.length} ciclos, ${rep.pairs.length} pares`);
  });
  app.post('/api/v1/export/excel', exportExcel);
  app.get('/api/v1/export/excel', exportExcel);

  const exportPdf = wrap(async (req, res) => {
    const q = { ...req.query, ...(req.body || {}) };
    const rep = report(q);
    const x = exportCtx(q);
    const buf = await buildPdf(rep, { trades: scopedTrades(q), userName: q.userName || req.user?.name, userEmail: req.user?.email, ...x });
    const fname = `ArbiTrack_Reporte_${x.fileTag}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.end(buf);
    log('EXPORT', `${fname}: ${rep.pairs.length} pares`);
  });
  app.post('/api/v1/export/pdf', exportPdf);
  app.get('/api/v1/export/pdf', exportPdf);

  app.get('/api/v1/audit', (req, res) => res.json({ audit: store.read().audit.slice(-500).reverse() }));

  app.use('/api', (req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Archivo demasiado grande (máx. 30 MB)' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido en la petición' });
    const status = err.status || 500;
    if (status >= 500) log('ERROR', err.stack || err.message);
    res.status(status).json({ success: false, error: err.message, ...(err.extra || {}) });
  });

  app.locals.store = localStore;
  app.locals.pool = pool;
  return app;
}

module.exports = { createApp, VERSION };

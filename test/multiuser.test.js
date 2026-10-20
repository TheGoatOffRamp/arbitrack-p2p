'use strict';
// Modo multiusuario contra un PostgreSQL real. Requiere TEST_DATABASE_URL (base de datos desechable: se vacía).
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');

const URL_DB = process.env.TEST_DATABASE_URL;
const SECRET = 'x'.repeat(40);

if (!URL_DB) {
  test('multiusuario (requiere TEST_DATABASE_URL)', { skip: 'defina TEST_DATABASE_URL para correr estas pruebas' }, () => {});
} else {
  const { createPool, migrate } = require('../src/db');
  const { decryptBox, deriveKey } = require('../src/secrets');

  let pool, ctx;
  const mails = [];
  const mailer = { send: async (m) => { mails.push(m); } };

  /** Cliente HTTP con su propia cookie de sesión (un "navegador"). */
  function browser() {
    let cookie = '';
    return async (method, url, body, headers = {}) => {
      const res = await fetch(ctx.base + url, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const ct = res.headers.get('content-type') || '';
      return { status: res.status, data: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), setCookie: sc };
    };
  }
  const register = async (email, password = 'contraseña-segura-1') => {
    const b = browser();
    const r = await b('POST', '/api/v1/auth/register', { email, password, name: email.split('@')[0] });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return b;
  };
  const trade = (o = {}) => ({ type: 'compra', date: '2026-09-01 10:00', exchange: 'Binance', crypto: 'USDT', fiat: 'PEN', amount: '100', price: '3.70', status: 'completado', ...o });

  test.before(async () => {
    pool = createPool(URL_DB);
    await migrate(pool);
    await migrate(pool); // idempotente
    await pool.query('TRUNCATE users CASCADE');
    ctx = await startApp({ pool, secret: SECRET, authLimits: { signupsPerHour: 1000 }, mailer, publicUrl: 'https://arbitrack.test' });
  });
  test.after(async () => { await ctx.close(); await pool.end(); });

  test('sin sesión no hay acceso a los datos', async () => {
    const b = browser();
    for (const [m, u] of [['GET', '/api/v1/trades'], ['GET', '/api/v1/stats'], ['GET', '/api/v1/export/excel'], ['POST', '/api/v1/trades'], ['GET', '/api/v1/auth/me']]) {
      const r = await b(m, u, m === 'POST' ? trade() : undefined);
      assert.equal(r.status, 401, `${m} ${u}`);
    }
    const h = await b('GET', '/health');
    assert.equal(h.data.mode, 'multiuser');
    assert.equal(h.data.trades, undefined, '/health no debe revelar datos');
  });

  test('registro, sesión, cierre e inicio de sesión', async () => {
    const b = browser();
    const r = await b('POST', '/api/v1/auth/register', { email: 'Ana@Mail.com', password: 'contraseña-segura-1', name: 'Ana' });
    assert.equal(r.status, 201);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Lax/);
    assert.equal(r.data.user.email, 'ana@mail.com');
    assert.equal((await b('GET', '/api/v1/auth/me')).data.user.name, 'Ana');

    assert.equal((await b('POST', '/api/v1/auth/register', { email: 'ana@mail.com', password: 'otra-contraseña-1' })).status, 409);
    assert.equal((await b('POST', '/api/v1/auth/register', { email: 'corta@mail.com', password: 'corta' })).status, 400);
    assert.equal((await b('POST', '/api/v1/auth/register', { email: 'no-es-email', password: 'contraseña-segura-1' })).status, 400);

    await b('POST', '/api/v1/auth/logout');
    assert.equal((await b('GET', '/api/v1/auth/me')).status, 401);
    assert.equal((await b('POST', '/api/v1/auth/login', { email: 'ana@mail.com', password: 'equivocada-123' })).status, 401);
    assert.equal((await b('POST', '/api/v1/auth/login', { email: 'nadie@mail.com', password: 'equivocada-123' })).status, 401);
    assert.equal((await b('POST', '/api/v1/auth/login', { email: 'ANA@mail.com', password: 'contraseña-segura-1' })).status, 200);
    assert.equal((await b('GET', '/api/v1/auth/me')).status, 200);

    const { rows } = await pool.query("SELECT password_hash FROM users WHERE email = 'ana@mail.com'");
    assert.match(rows[0].password_hash, /^scrypt\$/);
    const s = await pool.query('SELECT id FROM sessions');
    assert.ok(s.rows.every((x) => /^[0-9a-f]{64}$/.test(x.id)), 'solo se guarda el hash del token');
  });

  test('cada usuario ve únicamente sus operaciones', async () => {
    const a = await register('a@iso.com');
    const b = await register('b@iso.com');
    const created = await a('POST', '/api/v1/trades', trade({ orderId: 'A-1' }));
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const id = created.data.trade.id;
    await a('POST', '/api/v1/trades', trade({ orderId: 'A-2', type: 'venta', price: '3.75' }));

    assert.equal((await a('GET', '/api/v1/trades')).data.total, 2);
    assert.equal((await b('GET', '/api/v1/trades')).data.total, 0);
    assert.equal((await b('GET', `/api/v1/trades/${id}/trace`)).status, 404);
    assert.equal((await b('PUT', `/api/v1/trades/${id}`, { notes: 'hack' })).status, 404);
    assert.equal((await b('DELETE', `/api/v1/trades/${id}`)).status, 404);
    assert.equal((await b('GET', '/api/v1/stats')).data.totalTrades, 0);

    // La misma orden puede existir en dos cuentas distintas (deduplicación por usuario).
    assert.equal((await b('POST', '/api/v1/trades', trade({ orderId: 'A-1' }))).status, 200);
    assert.equal((await a('POST', '/api/v1/trades', trade({ orderId: 'A-1' }))).status, 409);

    const st = (await a('GET', '/api/v1/stats')).data;
    assert.equal(st.totalTrades, 2);
    assert.equal(st.grossProfit, 5);

    const x = await a('GET', '/api/v1/export/excel');
    assert.equal(x.status, 200);
    assert.equal(x.data.slice(0, 2).toString(), 'PK');
  });

  test('importación de archivos por usuario', async () => {
    const a = await register('imp@a.com');
    const b = await register('imp@b.com');
    const csv = 'Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Status,Created Time\n'
      + '9001,Buy,USDT,PEN,370,3.70,100,Completed,2026-09-01 10:00:00\n';
    const r = await a('POST', '/api/v1/import/file', { filename: 'binance.csv', content: csv, exchange: 'Binance', tz: 'America/Lima', commit: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.result.inserted, 1);
    assert.equal((await a('GET', '/api/v1/import/batches')).data.batches.length, 1);
    assert.equal((await b('GET', '/api/v1/import/batches')).data.batches.length, 0);
    assert.equal((await b('DELETE', `/api/v1/import/batches/${r.data.batchId}`)).status, 404);
  });

  test('API keys cifradas y separadas por usuario', async () => {
    const a = await register('keys@a.com');
    const b = await register('keys@b.com');
    const r = await a('POST', '/api/v1/exchange/connect', { exchange: 'Binance', apiKey: 'AKEY-1234567890', apiSecret: 'SECRETO-MUY-PRIVADO' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const list = (await a('GET', '/api/v1/exchanges')).data.exchanges;
    assert.equal(list.length, 1);
    assert.equal(list[0].apiKey, 'AKEY…7890');
    assert.equal((await b('GET', '/api/v1/exchanges')).data.exchanges.length, 0);

    const { rows } = await pool.query(`SELECT c.user_id, c.box FROM exchange_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = 'keys@a.com'`);
    assert.ok(!JSON.stringify(rows[0].box).includes('SECRETO'), 'no se guarda en texto plano');
    const key = deriveKey(SECRET);
    assert.equal(decryptBox(key, rows[0].box, rows[0].user_id).apiSecret, 'SECRETO-MUY-PRIVADO');
    const other = (await pool.query(`SELECT id FROM users WHERE email = 'keys@b.com'`)).rows[0].id;
    assert.throws(() => decryptBox(key, rows[0].box, other), 'una caja copiada a otro usuario no se descifra');
  });

  test('altas simultáneas del mismo usuario no se pisan', async () => {
    const a = await register('conc@a.com');
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => a('POST', '/api/v1/trades', trade({ orderId: `C-${i}` }))));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal((await a('GET', '/api/v1/trades')).data.total, 25);
  });

  test('peticiones que modifican datos desde otro sitio se rechazan', async () => {
    const a = await register('csrf@a.com');
    const r = await a('POST', '/api/v1/trades', trade(), { origin: 'https://sitio-malicioso.com' });
    assert.equal(r.status, 403);
    assert.equal((await a('POST', '/api/v1/trades', trade({ orderId: 'ok' }), { origin: ctx.base })).status, 200);
  });

  test('recuperación de contraseña', async () => {
    const a = await register('reset@a.com', 'contraseña-vieja-1');
    const other = browser();
    const f = await other('POST', '/api/v1/auth/password/forgot', { email: 'reset@a.com' });
    const f2 = await other('POST', '/api/v1/auth/password/forgot', { email: 'noexiste@a.com' });
    assert.deepEqual(f.data, f2.data, 'misma respuesta exista o no la cuenta');
    const mail = mails.find((m) => m.to === 'reset@a.com');
    const token = mail.text.match(/reset=([\w-]+)/)[1];
    assert.match(mail.text, /^.*https:\/\/arbitrack\.test\/login\.html\?reset=/m);

    assert.equal((await other('POST', '/api/v1/auth/password/reset', { token: 'falso', newPassword: 'contraseña-nueva-1' })).status, 400);
    assert.equal((await other('POST', '/api/v1/auth/password/reset', { token, newPassword: 'contraseña-nueva-1' })).status, 200);
    assert.equal((await other('POST', '/api/v1/auth/password/reset', { token, newPassword: 'contraseña-nueva-2' })).status, 400, 'el enlace es de un solo uso');
    assert.equal((await a('GET', '/api/v1/auth/me')).status, 401, 'las sesiones anteriores se cierran');
    assert.equal((await a('POST', '/api/v1/auth/login', { email: 'reset@a.com', password: 'contraseña-vieja-1' })).status, 401);
    assert.equal((await a('POST', '/api/v1/auth/login', { email: 'reset@a.com', password: 'contraseña-nueva-1' })).status, 200);
  });

  test('baja de la cuenta borra todos sus datos', async () => {
    const a = await register('baja@a.com');
    await a('POST', '/api/v1/trades', trade());
    await a('POST', '/api/v1/exchange/connect', { exchange: 'Bybit', apiKey: 'k1234567', apiSecret: 's1234567' });
    const id = (await a('GET', '/api/v1/auth/me')).data.user.id;
    assert.equal((await a('DELETE', '/api/v1/auth/account', { password: 'mal' })).status, 401);
    assert.equal((await a('DELETE', '/api/v1/auth/account', { password: 'contraseña-segura-1' })).status, 200);
    for (const t of ['users', 'ledgers', 'exchange_credentials', 'sessions']) {
      const col = t === 'users' ? 'id' : 'user_id';
      assert.equal((await pool.query(`SELECT count(*)::int n FROM ${t} WHERE ${col} = $1`, [id])).rows[0].n, 0, t);
    }
  });

  test('demasiados intentos de inicio de sesión se bloquean', async () => {
    await register('fuerza@a.com');
    const b = browser();
    let last;
    for (let i = 0; i < 11; i++) last = await b('POST', '/api/v1/auth/login', { email: 'fuerza@a.com', password: `intento-${i}-xxxx` });
    assert.equal(last.status, 429);
  });
}

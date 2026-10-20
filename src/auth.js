'use strict';
// Cuentas de usuario (modo multiusuario): registro, sesiones por cookie, recuperación de contraseña y baja.
const crypto = require('crypto');
const { promisify } = require('util');
const { tx } = require('./db');
const { emptyState } = require('./store');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = 'arbitrack_sid';
const SESSION_DAYS = 30;
const RESET_MINUTES = 60;
const MIN_PASSWORD = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Límite simple en memoria por clave (IP, IP+email…). Suficiente para una sola instancia. */
function limiter({ max, windowMs }) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const h = hits.get(key);
      if (!h || h.reset <= now) { hits.set(key, { n: 1, reset: now + windowMs }); return true; }
      h.n++;
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      return h.n <= max;
    },
    clear(key) { hits.delete(key); },
  };
}

const consoleMailer = {
  async send({ to, subject, text }) {
    console.log(`[MAIL] (sin SMTP configurado) Para: ${to} · ${subject}\n${text}`);
  },
};

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

/**
 * Rutas /api/v1/auth/* y middleware `requireUser` que carga req.user.
 * `HttpError` y `wrap` vienen de app.js para mantener el mismo formato de errores.
 */
function createAuth({ pool, HttpError, wrap, mailer = consoleMailer, publicUrl, secureCookies, log, limits = {} }) {
  const bad = (msg) => new HttpError(400, msg);
  const loginLimit = limiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const signupLimit = limiter({ max: limits.signupsPerHour || 10, windowMs: 60 * 60 * 1000 });
  const resetLimit = limiter({ max: 5, windowMs: 60 * 60 * 1000 });

  const cookieOpts = (maxAgeSec) => [
    `Path=/`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`, secureCookies ? 'Secure' : null,
  ].filter(Boolean).join('; ');

  async function startSession(req, res, userId) {
    const token = newToken();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
    await pool.query('INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [sha256(token), userId, expires, req.ip || null, String(req.get('user-agent') || '').slice(0, 300)]);
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieOpts(SESSION_DAYS * 86400)}`);
  }

  const clearCookie = (res) => res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOpts(0)}`);

  const validPassword = (pw) => {
    if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw bad(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres`);
    if (pw.length > 200) throw bad('La contraseña es demasiado larga');
  };
  const normEmail = (e) => {
    const s = String(e || '').trim().toLowerCase();
    if (!EMAIL_RE.test(s) || s.length > 254) throw bad('Email inválido');
    return s;
  };

  async function currentUser(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return null;
    const { rows } = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.expires_at > now()`, [sha256(token)]);
    return rows[0] || null;
  }

  const requireUser = wrap(async (req, res, next) => {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Inicia sesión para continuar', auth: false });
    req.user = u;
    next();
  });

  const express = require('express');
  const r = express.Router();

  r.post('/register', wrap(async (req, res) => {
    if (!signupLimit.hit(`ip:${req.ip}`)) throw new HttpError(429, 'Demasiados registros desde esta conexión. Intenta más tarde.');
    const { email, password, name } = req.body || {};
    const e = normEmail(email);
    validPassword(password);
    const id = crypto.randomUUID();
    const hash = await hashPassword(password);
    try {
      await tx(pool, async (c) => {
        await c.query('INSERT INTO users (id, email, name, password_hash) VALUES ($1, $2, $3, $4)', [id, e, String(name || '').trim().slice(0, 100) || null, hash]);
        await c.query('INSERT INTO ledgers (user_id, state) VALUES ($1, $2)', [id, emptyState()]);
      });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'Ya existe una cuenta con ese email');
      throw err;
    }
    await startSession(req, res, id);
    log('AUTH', `registro ${id}`);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    res.status(201).json({ success: true, user: publicUser(rows[0]) });
  }));

  r.post('/login', wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const e = String(email || '').trim().toLowerCase();
    const key = `${req.ip}|${e}`;
    if (!loginLimit.hit(key) || !loginLimit.hit(`ip:${req.ip}`)) throw new HttpError(429, 'Demasiados intentos. Espera unos minutos.');
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [e]);
    const u = rows[0];
    // Se verifica igual con un hash ficticio para no revelar por el tiempo de respuesta si el email existe.
    const ok = await verifyPassword(String(password || ''), u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, 'Email o contraseña incorrectos');
    loginLimit.clear(key);
    await startSession(req, res, u.id);
    res.json({ success: true, user: publicUser(u) });
  }));

  r.post('/logout', wrap(async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await pool.query('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
    clearCookie(res);
    res.json({ success: true });
  }));

  r.get('/me', requireUser, (req, res) => res.json({ mode: 'multiuser', user: publicUser(req.user) }));

  r.put('/me', requireUser, wrap(async (req, res) => {
    const { name } = req.body || {};
    const { rows } = await pool.query('UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING *', [req.user.id, String(name || '').trim().slice(0, 100) || null]);
    res.json({ success: true, user: publicUser(rows[0]) });
  }));

  r.post('/password/change', requireUser, wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!(await verifyPassword(String(currentPassword || ''), req.user.password_hash))) throw new HttpError(401, 'La contraseña actual no es correcta');
    validPassword(newPassword);
    await tx(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user.id, await hashPassword(newPassword)]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
    });
    await startSession(req, res, req.user.id);
    res.json({ success: true });
  }));

  // Siempre responde lo mismo, exista o no la cuenta.
  r.post('/password/forgot', wrap(async (req, res) => {
    const e = String((req.body || {}).email || '').trim().toLowerCase();
    const generic = { success: true, message: 'Si el email está registrado, te enviamos un enlace para restablecer la contraseña.' };
    if (!resetLimit.hit(`ip:${req.ip}`) || !resetLimit.hit(`e:${e}`)) return res.json(generic);
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [e]);
    if (rows[0]) {
      const token = newToken();
      await pool.query('INSERT INTO password_resets (id, user_id, expires_at) VALUES ($1, $2, $3)',
        [sha256(token), rows[0].id, new Date(Date.now() + RESET_MINUTES * 60000)]);
      const base = publicUrl || `${req.protocol}://${req.get('host')}`;
      await mailer.send({
        to: rows[0].email,
        subject: 'ArbiTrack P2P · Restablecer contraseña',
        text: `Para crear una nueva contraseña abre este enlace (vence en ${RESET_MINUTES} minutos):\n${base}/login.html?reset=${token}\n\nSi no lo pediste, ignora este mensaje.`,
      });
    }
    res.json(generic);
  }));

  r.post('/password/reset', wrap(async (req, res) => {
    const { token, newPassword } = req.body || {};
    validPassword(newPassword);
    const userId = await tx(pool, async (c) => {
      const { rows } = await c.query(
        'SELECT * FROM password_resets WHERE id = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [sha256(String(token || ''))]);
      if (!rows[0]) throw bad('El enlace no es válido o ya venció. Pide uno nuevo.');
      await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [rows[0].id]);
      await c.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [rows[0].user_id, await hashPassword(newPassword)]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].user_id]);
      return rows[0].user_id;
    });
    await startSession(req, res, userId);
    res.json({ success: true });
  }));

  // Baja de la cuenta: borra usuario, sesiones, libro y credenciales (ON DELETE CASCADE).
  r.delete('/account', requireUser, wrap(async (req, res) => {
    if (!(await verifyPassword(String((req.body || {}).password || ''), req.user.password_hash))) throw new HttpError(401, 'La contraseña no es correcta');
    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    clearCookie(res);
    log('AUTH', `baja ${req.user.id}`);
    res.json({ success: true });
  }));

  return { router: r, requireUser };
}

// Hash válido de una contraseña que nadie conoce; solo se usa para igualar tiempos.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

module.exports = { createAuth, hashPassword, verifyPassword, readCookie, COOKIE, MIN_PASSWORD };

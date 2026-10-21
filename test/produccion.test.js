'use strict';
// Requisitos para publicar: emails, cabeceras de seguridad y configuración obligatoria en producción.
const test = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers');
const { createMailer } = require('../src/mailer');
const { createApp } = require('../src/app');

test('mailer: Resend con la clave configurada', async () => {
  const calls = [];
  const m = createMailer({ apiKey: 're_test', from: 'ArbiTrack <no-responder@arbitrack.test>', fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; } });
  assert.equal(m.configured, true);
  await m.send({ to: 'ana@mail.com', subject: 'Hola', text: 'Texto' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'ArbiTrack <no-responder@arbitrack.test>', to: ['ana@mail.com'], subject: 'Hola', text: 'Texto' });

  const failing = createMailer({ apiKey: 're_test', from: 'x@y.z', fetchImpl: async () => ({ ok: false, status: 422, text: async () => 'dominio no verificado' }) });
  await assert.rejects(failing.send({ to: 'a@b.c', subject: 's', text: 't' }), /Resend 422.*dominio no verificado/);
  assert.throws(() => createMailer({ apiKey: 're_test', from: '' }), /MAIL_FROM/);
});

test('mailer: SMTP (p. ej. Gmail) sin dominio propio', async () => {
  const sent = [];
  let opts;
  const m = createMailer({ apiKey: '', from: '', smtp: { host: 'smtp.gmail.com', port: '465', user: 'yo@gmail.com', pass: 'app-pass' },
    createTransport: (o) => { opts = o; return { sendMail: async (msg) => sent.push(msg) }; } });
  assert.equal(m.configured, true);
  await m.send({ to: 'ana@mail.com', subject: 'Hola', text: 'Texto' });
  assert.equal(opts.secure, true);
  assert.deepEqual(opts.auth, { user: 'yo@gmail.com', pass: 'app-pass' });
  assert.deepEqual(sent[0], { from: 'ArbiTrack <yo@gmail.com>', to: 'ana@mail.com', subject: 'Hola', text: 'Texto' });
  assert.throws(() => createMailer({ apiKey: '', smtp: { host: 'smtp.gmail.com', user: 'yo@gmail.com' } }), /SMTP_PASS/);
});

test('mailer: sin clave escribe en el log', async () => {
  const lines = [];
  const m = createMailer({ apiKey: '', smtp: {}, log: (l) => lines.push(l) });
  assert.equal(m.configured, false);
  await m.send({ to: 'a@b.c', subject: 'Asunto', text: 'enlace' });
  assert.match(lines[0], /a@b\.c.*Asunto/s);
});

test('cabeceras de seguridad', async () => {
  const ctx = await startApp();
  try {
    const res = await fetch(`${ctx.base}/api/v1/trades`);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally { await ctx.close(); }
});

test('en producción multiusuario ARBITRACK_PUBLIC_URL es obligatoria', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => createApp({ pool: {}, secret: 'x'.repeat(40), publicUrl: '' }), /ARBITRACK_PUBLIC_URL/);
    assert.throws(() => createApp({ pool: {}, secret: 'corta' }), /ARBITRACK_SECRET/);
    assert.doesNotThrow(() => createApp({ pool: {}, secret: 'x'.repeat(40), publicUrl: 'https://arbitrack.test/', mailer: { send: async () => {} } }));
  } finally { process.env.NODE_ENV = prev; }
});

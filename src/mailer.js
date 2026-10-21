'use strict';
// Envío de emails (recuperación de contraseña), en este orden:
// 1. RESEND_API_KEY → Resend (https://resend.com); requiere un dominio propio verificado para escribir a cualquier persona.
// 2. SMTP_HOST → cualquier servidor SMTP, p. ej. Gmail con una contraseña de aplicación (no requiere dominio).
// 3. Nada configurado → el mensaje se escribe en el log del servidor (solo útil en desarrollo).

function createMailer({
  apiKey = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM, fetchImpl = fetch, log = console.log,
  smtp = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  createTransport = (o) => require('nodemailer').createTransport(o),
} = {}) {
  if (!apiKey && smtp.host) {
    if (!smtp.user || !smtp.pass) throw new Error('Defina SMTP_USER y SMTP_PASS para enviar emails por SMTP.');
    const port = Number(smtp.port || 465);
    const transport = createTransport({ host: smtp.host, port, secure: port === 465, auth: { user: smtp.user, pass: smtp.pass },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    const sender = from || `ArbiTrack <${smtp.user}>`;
    return {
      configured: true,
      async send({ to, subject, text }) {
        try { await transport.sendMail({ from: sender, to, subject, text }); } catch (e) {
          throw new Error(`No se pudo enviar el email (SMTP ${smtp.host}): ${e.message}`);
        }
      },
    };
  }
  if (!apiKey) {
    return {
      configured: false,
      async send({ to, subject, text }) { log(`[MAIL] (sin RESEND_API_KEY ni SMTP) Para: ${to} · ${subject}\n${text}`); },
    };
  }
  if (!from) throw new Error('Defina MAIL_FROM (p. ej. "ArbiTrack <no-responder@tu-dominio.com>") para enviar emails con Resend.');
  return {
    configured: true,
    async send({ to, subject, text }) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`No se pudo enviar el email (Resend ${res.status}): ${body.slice(0, 200)}`);
      }
    },
  };
}

module.exports = { createMailer };

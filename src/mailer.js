'use strict';
// Envío de emails (recuperación de contraseña). Con RESEND_API_KEY usa Resend (https://resend.com);
// sin configurar, escribe el mensaje en el log del servidor (solo útil en desarrollo).

function createMailer({ apiKey = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM, fetchImpl = fetch, log = console.log } = {}) {
  if (!apiKey) {
    return {
      configured: false,
      async send({ to, subject, text }) { log(`[MAIL] (sin RESEND_API_KEY) Para: ${to} · ${subject}\n${text}`); },
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

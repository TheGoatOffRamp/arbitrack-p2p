'use strict';
const { createApp, VERSION } = require('./src/app');

const PORT = Number(process.env.PORT || 3001);
const multiUser = !!process.env.DATABASE_URL;
// Modo local: por seguridad escucha solo en esta computadora. Para exponerlo en red: HOST=0.0.0.0 y ARBITRACK_TOKEN=<secreto>.
// Modo multiusuario (DATABASE_URL): cada petición exige sesión, así que escucha en todas las interfaces.
const HOST = process.env.HOST || (multiUser ? '0.0.0.0' : '127.0.0.1');

if (!multiUser && HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.ARBITRACK_TOKEN) {
  console.error('ERROR: para escuchar fuera de localhost defina ARBITRACK_TOKEN (las rutas /api quedarían expuestas sin autenticación).');
  process.exit(1);
}

async function main() {
  let pool = null;
  if (multiUser) {
    const { createPool, migrate } = require('./src/db');
    pool = createPool();
    // Recién creada (o tras un mantenimiento) la base de datos puede tardar unos minutos en aceptar conexiones.
    for (let attempt = 1; ; attempt++) {
      try { await migrate(pool); break; } catch (e) {
        const transient = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P03'].includes(e.code);
        if (!transient || attempt >= 30) throw e;
        console.warn(`Base de datos no disponible (${e.code}); reintento ${attempt}/30 en 10 s…`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  }
  const app = createApp({ pool });
  const server = app.listen(PORT, HOST, () => {
    console.log(`ArbiTrack Backend v${VERSION} — http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (multiUser) console.log(`Modo multiusuario (PostgreSQL) · Zona horaria: ${process.env.ARBITRACK_TZ || 'America/Lima'}`);
    else console.log(`Modo local · Datos: ${app.locals.store.dir} · Zona horaria: ${process.env.ARBITRACK_TZ || 'America/Lima'}`);
    if (multiUser && !process.env.RESEND_API_KEY && !process.env.SMTP_HOST) console.warn('AVISO: sin RESEND_API_KEY ni SMTP_HOST los emails de recuperación de contraseña solo se escriben en el log.');
  });

  let cleanup = null;
  if (multiUser) {
    // Sesiones y enlaces de recuperación vencidos: se borran cada hora.
    const purge = () => pool.query('DELETE FROM sessions WHERE expires_at < now(); DELETE FROM password_resets WHERE expires_at < now() - interval \'1 day\'')
      .catch((e) => console.error(`Limpieza de sesiones falló: ${e.message}`));
    purge();
    cleanup = setInterval(purge, 60 * 60 * 1000);
    cleanup.unref();
  }

  // El hosting envía SIGTERM al publicar una versión nueva: se terminan las peticiones en curso antes de salir.
  const shutdown = (sig) => {
    console.log(`${sig}: cerrando…`);
    clearInterval(cleanup);
    server.close(async () => {
      if (pool) await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error(`No se pudo iniciar ArbiTrack: ${e.message}`);
  process.exit(1);
});

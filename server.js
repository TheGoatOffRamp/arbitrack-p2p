'use strict';
const { createApp, VERSION } = require('./src/app');

const PORT = Number(process.env.PORT || 3001);
// Por seguridad escucha solo en esta computadora. Para exponerlo en red: HOST=0.0.0.0 y ARBITRACK_TOKEN=<secreto>.
const HOST = process.env.HOST || '127.0.0.1';

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.ARBITRACK_TOKEN) {
  console.error('ERROR: para escuchar fuera de localhost defina ARBITRACK_TOKEN (las rutas /api quedarían expuestas sin autenticación).');
  process.exit(1);
}

let app;
try {
  app = createApp();
} catch (e) {
  console.error(`No se pudo iniciar ArbiTrack: ${e.message}`);
  process.exit(1);
}

app.listen(PORT, HOST, () => {
  console.log(`ArbiTrack Backend v${VERSION} — http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Datos: ${app.locals.store.dir} · Zona horaria: ${process.env.ARBITRACK_TZ || 'America/Lima'}`);
});

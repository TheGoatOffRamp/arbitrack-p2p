# Publicar ArbiTrack P2P

Guía para poner la web en internet con **Render** (hosting + PostgreSQL), un dominio propio y **Resend** (emails).
Tiempo estimado: 1 a 2 horas, la mayor parte esperando que se propaguen los DNS.

> Los precios y nombres de planes son los de Render y Resend a octubre de 2026; confírmalos en sus páginas antes de pagar.

## Costos aproximados

| Servicio | Plan | Costo |
|---|---|---|
| Render — web | Starter | ~7 USD/mes |
| Render — PostgreSQL | Basic 256 MB | ~6 USD/mes |
| Dominio | `.com` o `.pe` | ~12–40 USD/año |
| Resend | Free (3 000 emails/mes) | 0 |

## 1. Crear la web y la base de datos (Render)

1. Crea una cuenta en <https://render.com> e inicia sesión con GitHub.
2. **New → Blueprint** y elige el repositorio `TheGoatOffRamp/arbitrack-p2p`. Render lee `render.yaml` y propone crear:
   - `arbitrack` (la web) y `arbitrack-db` (PostgreSQL 16), ambos en Frankfurt. **No uses una región de EE.UU.**: Binance, Bybit y Bitget bloquean las APIs desde servidores en EE.UU. (error HTTP 451 al sincronizar).
3. Te pedirá tres valores:
   - `ARBITRACK_PUBLIC_URL`: por ahora `https://arbitrack.onrender.com` (o el nombre que Render te asigne; lo cambias al tener dominio).
   - `RESEND_API_KEY` y `MAIL_FROM`: déjalos vacíos por ahora (paso 4).
4. **Apply**. La primera publicación tarda unos minutos. Las tablas de la base de datos se crean solas.
5. Abre la URL, crea tu cuenta y prueba registrar una operación.

**Muy importante:** en Render → `arbitrack` → *Environment*, copia el valor de `ARBITRACK_SECRET` a tu gestor de contraseñas.
Si se pierde o cambia, las API keys guardadas por los usuarios ya no se pueden descifrar (tendrían que volver a conectarlas).

Cada vez que se sube un cambio a `main` en GitHub, Render publica la nueva versión automáticamente. GitHub corre las pruebas en cada cambio (pestaña *Actions*).

## 2. Pasar tus datos de la versión local

1. En Render → `arbitrack-db` → *Connect* → copia la **External Database URL**.
2. En tu computadora, dentro de la carpeta del proyecto (con tu carpeta `data/` de la versión local):

```bash
PGSSL=true DATABASE_URL="<External Database URL>" ARBITRACK_SECRET="<el de Render>" \
  npm run importar-local -- --email tu@correo.com --data ./data
```

## 3. Dominio propio

1. Compra el dominio (por ejemplo en Namecheap o Cloudflare para `.com`, o en un registrador de `.pe`).
2. Render → `arbitrack` → *Settings → Custom Domains* → agrega `arbitrack.pe` y `www.arbitrack.pe`.
3. En tu registrador crea los registros DNS que Render te indique. Render emite el certificado HTTPS solo.
4. Cambia `ARBITRACK_PUBLIC_URL` a `https://arbitrack.pe` (*Environment* → *Save*; se reinicia solo).

## 4. Emails de recuperación de contraseña (Resend)

1. Crea una cuenta en <https://resend.com>.
2. *Domains → Add domain* → tu dominio. Agrega en tu registrador los registros DNS que te muestra y espera a que diga **Verified**.
3. *API Keys → Create* (permiso *Sending access*).
4. En Render → *Environment*:
   - `RESEND_API_KEY` = la clave creada
   - `MAIL_FROM` = `ArbiTrack <no-responder@arbitrack.pe>`
5. Prueba: en la web, *¿Olvidaste tu contraseña?* con tu email. Si no llega, revisa los logs de Render (busca `[MAIL]`).

## 5. Respaldos

Render hace respaldos diarios de las bases de datos de pago y permite restaurar a un punto anterior
(*arbitrack-db → Recovery*). Revisa ahí cuántos días se conservan en tu plan.
Adicionalmente, cada usuario puede descargar su Excel y su PDF cuando quiera.

## 6. Aspectos legales (antes de abrir a otros usuarios)

1. Completa los datos entre `[corchetes]` en `public/privacidad.html` y `public/terminos.html` y que los revise un abogado.
2. Inscribe el banco de datos personales de usuarios ante la Autoridad Nacional de Protección de Datos Personales (Ley 29733).
3. Quita el aviso de "Borrador" de ambas páginas.

## Lista final

- [ ] Web publicada y cuenta propia creada
- [ ] `ARBITRACK_SECRET` guardada aparte
- [ ] Datos locales importados
- [ ] Dominio con HTTPS y `ARBITRACK_PUBLIC_URL` actualizada
- [ ] Email de recuperación probado
- [ ] Privacidad y términos completados y revisados

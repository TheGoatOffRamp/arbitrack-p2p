# ArbiTrack P2P — Backend v2.0

Registro, seguimiento y control contable de operaciones de arbitraje P2P entre exchanges y monedas.

```bash
npm install
npm start          # http://localhost:3001  (solo esta computadora)
npm test           # 48 pruebas: unitarias, contables, importación, APIs, HTTP, volumen
npm run ejemplo    # genera examples/ArbiTrack_ejemplo.xlsx con datos ficticios
```

Al primer arranque, si existe `data/trades.json` del backend anterior, se **migra automáticamente**
(copia de respaldo `data/trades.legacy-<fecha>.json`) y las credenciales en texto plano se cifran.

---

## 1. Hallazgos de la auditoría (v1.3 → v2.0)

Cada hallazgo marcado ✔ fue reproducido y cubierto por una prueba.

### Cálculos financieros
| # | Problema en v1.3 | Impacto | Corrección |
|---|---|---|---|
| ✔1 | `/stats` y el Excel calculaban ganancia = Σventas − Σcompras **mezclando PEN, USD, USDT y BTC**. | Reproducido: 1 compra y 1 venta USDT/PEN + 1 compra USDT/USD → reportaba **−1490** en vez de +5. | Resultados **por par**, nunca se suman monedas distintas. |
| ✔2 | Ganancia = flujo de caja: el inventario sin vender contaba como pérdida. | Cualquier ciclo abierto distorsionaba el resultado. | Costo de lo vendido por **FIFO**; inventario final valorizado a costo. |
| ✔3 | Las comisiones se sumaban pero **no se restaban** de la ganancia, y se sumaban comisiones cripto + fiat juntas. | Ganancia sobrestimada. | Bruta → Comisiones → Otros costos → Neta, con cada comisión valorizada en la moneda del par. |
| ✔4 | Aritmética con `float` de JavaScript. | Errores de redondeo acumulados. | Decimal exacto (`decimal.js`); montos guardados como texto decimal. |
| ✔5 | Excel: moneda y cripto tomadas de la **primera** operación; columna "Fee (USDT)" aunque fuera PEN. | Encabezados y totales incorrectos. | Excel rehecho (ver §5). |

### Estados, duplicados e importación
| # | Problema | Corrección |
|---|---|---|
| ✔6 | Importar el **mismo archivo dos veces duplicaba todo** (IDs aleatorios). | Deduplicación por exchange + N° de orden (o huella si no hay ID), también dentro del mismo archivo. |
| ✔7 | `SELL` / `Sell` se registraba como **compra** (solo reconocía "vent"). | Normalización de tipo en español/inglés; valores no reconocidos se rechazan con motivo. |
| ✔8 | Estado ausente → **"completado"**; cripto ausente → USDT; fiat ausente → PEN. | Sin valores por defecto silenciosos: falta de moneda = fila rechazada; estado desconocido = no se contabiliza y se marca. |
| ✔9 | Binance `CANCELLED_BY_SYSTEM` y Bybit "cancelado" (40) quedaban como **pendientes**. | Tablas de estados por exchange: completado, pendiente, cancelado, fallido, en disputa. |
| ✔10 | Resincronizar sobrescribía ediciones manuales. | Los campos editados por el usuario se conservan; los conflictos se reportan; todo cambio queda en el historial. |

### Fechas
| # | Problema | Corrección |
|---|---|---|
| ✔11 | API: se guardaba la hora **UTC sin zona** y la webapp la mostraba como hora de Lima → **+5 h** (y a veces el día siguiente). Reproducido: una orden de las 20:30 del 1-sep aparecía el 2-sep 01:30. | Todo se guarda como instante UTC (`dateUtc`); el campo `date` que usa la webapp ahora está en hora de Lima. La migración corrige los registros antiguos según su origen. |
| ✔12 | Rango de sincronización: inicio en UTC y fin en hora del servidor. | Días completos en hora de Lima. |
| ✔13 | `DD/MM` vs `MM/DD` nunca se consideraba. | Se detecta por columna completa; si es ambiguo se pide el formato. |

### APIs
| # | Problema | Corrección |
|---|---|---|
| ✔14 | **Bybit**: GET a un endpoint que es POST; **compra y venta invertidas** (`side 0` = compra); cantidad cripto leída de un campo inexistente (siempre 0); sin paginación (máx. 50). | Reescrito según la documentación oficial, firma POST, paginación y ventanas de 30 días. |
| ✔15 | **Bitget**: `amount` (monto **fiat**) se guardaba como cantidad cripto; total siempre 0; sin paginación. | `count` = cripto, `amount` = fiat, paginación por `idLessThan`, ventanas ≤ 90 días. |
| ✔16 | **OKX**: consultaba `/otc/rfq/trade` (mercado RFQ institucional, **no P2P**). | OKX no tiene API pública de historial P2P: se importa por archivo. |
| ✔17 | Errores a mitad de sincronización guardaban datos **parciales**; errores devueltos con `success: true`. | Sincronización **todo o nada**; validación de estructura de cada registro; reintentos (429/5xx, `Retry-After`), timeouts. |

### Arquitectura y seguridad
| # | Problema | Corrección |
|---|---|---|
| ✔18 | Rutas `PUT /trades/:id` definidas 3 veces y `POST /trades` duplicado (código muerto). | Rutas únicas, compatibles con la webapp. |
| ✔19 | Escrituras no atómicas y sin control de concurrencia: peticiones simultáneas se pisaban. | Escritura atómica + respaldo `.bak` + cola de mutaciones (probado con 40 altas simultáneas). |
| ✔20 | API keys en texto plano; CORS abierto; servidor escuchando en todas las interfaces sin autenticación. | Credenciales cifradas AES-256-GCM; escucha en `127.0.0.1`; token opcional `ARBITRACK_TOKEN`; CORS restringido. |
| ✔21 | Borrado destructivo sin rastro. | Eliminación lógica con historial y restauración; deshacer lotes de importación. |

---

### Formatos verificados con exportaciones reales

| Exchange | Archivo | Particularidades que se manejan solas |
|---|---|---|
| Bybit | CSV | `Direction`, `Coin Amount`, `Fiat Amount`, `Time (UTC-05:00)`. Si el CSV pasó por Google Sheets/Excel y los números quedaron alterados ("2903501" en vez de 290.3501), se reconstruyen y se verifica fila por fila que cantidad × precio = total; si no se puede demostrar, se bloquea. |
| Bitget | CSV | `Flat` = moneda fiat, `Amount` = fiat, `Quantity` = cripto, TAB antes del N° de orden. No indica zona horaria: se asume Lima y se avisa. No incluye comisión. |
| OKX | CSV (español) | `Volumen` = cripto, `Monto` = fiat, `Comprar/Vender`, `Fuente de orden` no es el exchange. No incluye comisión. |
| El Dorado | XLSX | Sin columna de estado (se usa "Orden Completada"), tasa redondeada (precio = FIAT ÷ cripto), comisión en USDT, `Comerciante` no es el exchange, métodos de pago legibles. |

**Zona horaria automática**: en Bybit, OKX y El Dorado el N° de orden contiene la hora en que el exchange creó la orden
(Bybit: ID snowflake; OKX: AAMMDDhhmmss en UTC+8; El Dorado: UUID v7). Se compara con la hora del archivo y se deduce su zona
exacta, sin preguntar.

## Interfaz (carpeta `public/`)

- `index.html`: página de inicio (sin login falso: el botón abre la app directamente; la app solo es accesible desde tu computadora).
- `app.html`: la aplicación, con el mismo diseño de siempre. Ya no calcula nada por su cuenta: todos los números vienen del backend.

Correcciones en la interfaz:

| Antes | Ahora |
|---|---|
| Dashboard y Excel calculaban "ventas − compras", mezclando monedas y con comisiones mal convertidas | Resultados FIFO del backend, por mercado (selector de par), con filtro de fechas |
| Importador propio: "Amount" iba al total, "cancelado" → "pendiente", fechas +5 h, cantidades redondeadas a 2 decimales, moneda PEN asumida | Importador del backend con vista previa, verificación de hora, filas rechazadas con motivo y corrección de columnas; acepta CSV y XLSX |
| Al editar, el total real se reemplazaba por cantidad × precio y se reenviaban todos los campos | Solo se envían los campos que cambiaste; el total del exchange no se toca |
| Fecha por defecto en hora UTC | Hora de Lima |
| "Borrar todo" solo limpiaba la pantalla; lista negra en el navegador | Eliminación real y trazable, con restauración y "deshacer lote" en Configuración |
| Login que aceptaba cualquier usuario y contraseña | Eliminado; el servidor solo escucha en tu computadora |
| Bitget sin passphrase; OKX/El Dorado como si tuvieran API | Passphrase incluida; OKX/El Dorado/KuCoin por archivo |
| Textos de archivos insertados sin escapar | Todo se escapa |
| Nueva sección **Incidencias** y detalle de cada operación (trazabilidad FIFO, historial, dato original) | |

Los gráficos usan Chart.js desde internet (CDN); sin conexión, la app funciona pero sin gráficos.

## 2. Reglas contables

- **Solo se contabilizan operaciones completadas y sin errores.** Pendientes, canceladas, fallidas, en disputa o con estado desconocido no afectan resultados, inventario ni totales.
- **Un par = un mercado** (`USDT/PEN`, `USDT/USD`, `BTC/PEN`…). Inventario, costo y resultado independientes. Nada se convierte entre monedas.
- **FIFO por par** a través de todos los exchanges (comprar en A, transferir y vender en B es un solo inventario).
- **Ciclo automático** = una venta + los lotes de compra que consume. **Ciclo manual** = grupo definido por el usuario con inventario propio; asignar una operación de otro par se rechaza.
- **Comisiones**: en cripto de una compra → reduce lo recibido y se valoriza al precio de la compra; en cripto de una venta → consume inventario a costo FIFO; en fiat → su importe.
- **Otros costos** (red, bancos, transferencias) se registran en `/costs`, en la cripto o el fiat del par.
- **Ventas sin compra registrada**: la parte sin costo conocido **no** se reconoce como ganancia; se reporta.
- **Control de conciliación por par**: flujo de caja neto + variación de inventario a costo = ganancia neta (diferencia 0; verificado en 2 000 escenarios aleatorios).

## 3. Importación de archivos

`POST /api/v1/import/file`

```jsonc
{
  "filename": "binance_p2p.csv",
  "content": "<texto CSV>",          // o "contentBase64" para CSV/XLSX
  "exchange": "Binance",             // opcional: forzar exchange
  "tz": "America/Lima",              // opcional: zona de las horas del archivo
  "dateOrder": "DMY",                // opcional si las fechas son ambiguas
  "decimal": ",",                    // opcional
  "mapping": { "amount": "Amount" }, // opcional: campo → nombre de columna
  "onlyPairs": ["USDT/PEN"],         // opcional
  "commit": false                    // false = vista previa; true = registrar
}
```

Flujo: **archivo → exchange → mapeo → normalización → validación → registro**.
Sin `commit` devuelve la vista previa: exchange detectado, columnas asignadas, cómo se interpretó la primera fecha, filas rechazadas con motivo e incidencias. Con `commit: true` registra solo si no hay bloqueos. Las filas rechazadas quedan en cuarentena (`GET /api/v1/import/quarantine`); cada operación conserva la fila original (`raw`), archivo y número de fila.

Perfiles incluidos: Binance, Bybit, Bitget, OKX, El Dorado y uno genérico. El genérico **no** asigna columnas ambiguas ("Amount", "Cantidad", "Monto"): pide mapeo explícito. Si la mayoría de filas no cuadra (cantidad × precio ≠ total) la importación se bloquea y, si corresponde, indica que las columnas parecen intercambiadas.

> ⚠ Los nombres de columna de cada perfil se basan en los formatos conocidos de cada exchange. Antes de usarlo en producción conviene validarlos con un archivo real de cada uno (ver `src/importers/profiles.js`; agregar un sinónimo es una línea).

## 4. Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servidor |
| POST / DELETE / GET | `/api/v1/exchange/connect` · `/api/v1/exchange/:ex` · `/api/v1/exchanges` | Credenciales (cifradas; se muestran enmascaradas) |
| POST | `/api/v1/sync/:exchange` | Sincroniza Binance, Bybit o Bitget (`startDate`, `endDate`) |
| GET | `/api/v1/trades` | Filtros: `from`, `to`, `exchange`, `type`, `status`, `pair`, `includeDeleted` |
| POST / PUT | `/api/v1/trades` · `/api/v1/trades/:id` | Alta manual / edición (queda historial) |
| DELETE · POST | `/api/v1/trades/:id` · `/api/v1/trades/:id/restore` | Eliminación lógica y restauración |
| GET | `/api/v1/trades/:id/trace` | **Trazabilidad**: dato original, historial, ciclos y asignaciones FIFO |
| POST | `/api/v1/import/file` | Importación de CSV/XLSX (§3) |
| POST | `/api/v1/import` | Importación heredada de la webapp (misma validación) |
| GET · DELETE | `/api/v1/import/batches` · `/api/v1/import/batches/:id` | Lotes; deshacer un lote |
| GET / POST / DELETE | `/api/v1/cycles` · `/api/v1/cycles/:id/trades` | Ciclos manuales |
| GET / POST / DELETE | `/api/v1/costs` | Otros costos |
| GET | `/api/v1/stats` | Estadísticas por par (`byPair`); campos heredados = un solo par |
| GET | `/api/v1/report` | Resultado completo (pares, ciclos, FIFO, comisiones, incidencias) |
| GET | `/api/v1/issues` | Incidencias (`severity=error|warning|info`) |
| GET / POST | `/api/v1/export/excel` | Excel contable (`from`, `to`, `userName`) |
| GET | `/api/v1/audit` | Registro de acciones |

## 5. Excel contable

Hojas: **Resumen** (estado de resultados por par con controles) · **Operaciones** · **Ciclos** (con neta acumulada por fórmula) · **Trazabilidad FIFO** · **Por moneda** (totales con `SUMIFS` verificables) · **Por exchange** · **Por período** · **Comisiones** · **Otros costos** · **Excluidas** · **Incidencias** · **Metodología**.
Fechas como fechas reales de Excel en hora de Lima, importes como números, filtros y encabezados fijos, impresión horizontal ajustada al ancho.

## 6. Configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | 3001 | Puerto |
| `HOST` | 127.0.0.1 | Para exponer en red: `0.0.0.0` (exige `ARBITRACK_TOKEN`) |
| `ARBITRACK_TOKEN` | — | Token para `/api` (`x-arbitrack-token` o `Authorization: Bearer`) |
| `ARBITRACK_SECRET` | archivo `data/.key` | Clave de cifrado de credenciales (recomendado definirla) |
| `ARBITRACK_TZ` | America/Lima | Zona horaria de presentación |
| `ARBITRACK_DATA_DIR` | `./data` | Carpeta de datos |
| `ARBITRACK_CORS` | localhost | Orígenes permitidos adicionales (coma) |

## 7. Estructura

```
server.js                    arranque
src/app.js                   rutas HTTP
src/model.js                 modelo canónico, estados, validaciones
src/dates.js · numbers.js    fechas/zonas horarias y números de exportaciones
src/money.js                 aritmética decimal exacta
src/store.js · ledger.js     almacenamiento atómico, deduplicación, historial
src/migrate.js               migración desde v1.3
src/secrets.js               credenciales cifradas
src/importers/               lectura CSV/XLSX, perfiles por exchange, análisis
src/exchanges/               clientes API (Binance, Bybit, Bitget) con reintentos
src/accounting/engine.js     motor FIFO, ciclos, conciliación
src/accounting/excel.js      reporte Excel
test/                        pruebas (node --test)
```

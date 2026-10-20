// Genera un libro de ejemplo con datos ficticios para revisar el formato del Excel.
// Uso: node examples/generar-ejemplo.js  → examples/ArbiTrack_ejemplo.xlsx y examples/ArbiTrack_ejemplo.pdf
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.NODE_ENV = 'test';
const { createApp } = require('../src/app');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-ej-'));
const app = createApp({ dataDir: dir, publicDir: dir });
const srv = app.listen(0, async () => {
  const B = `http://127.0.0.1:${srv.address().port}/api/v1`;
  const post = (u, b) => fetch(B + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  const binance = `Order Number,Order Type,Asset Type,Fiat Type,Total Price,Price,Quantity,Maker Fee,Taker Fee,Couterparty,Status,Created Time
22810000000000000001,Buy,USDT,PEN,"1,850.00",3.700,500.00,0.25,0,comprador_lima,Completed,2026-09-02 09:12:40
22810000000000000002,Buy,USDT,PEN,"1,114.50",3.715,300.00,0.15,0,p2p_rapido,Completed,2026-09-02 10:03:11
22810000000000000003,Sell,USDT,PEN,"1,886.00",3.772,500.00,0,0,casa_cambio_x,Completed,2026-09-02 13:40:02
22810000000000000004,Sell,USDT,PEN,376.50,3.765,100.00,0,0,jperez,Cancelled,2026-09-03 08:01:00
22810000000000000005,Buy,USDT,USD,200.00,1.000,200.00,0,0,miami_otc,Completed,2026-09-03 12:00:00
22810000000000000006,Sell,USDT,USD,202.00,1.010,200.00,0,0,miami_otc2,Completed,2026-09-04 12:00:00`;
  const eldorado = `ID;Tipo;Criptomoneda;Moneda Fiat;Cantidad de cripto;Precio;Cantidad de FIAT;Comisión;Estado;Fecha;Contraparte
ED-1001;Venta;USDT;PEN;298,60;3,780;1.128,71;0;Completado;03/09/2026 18:22;Rosa
ED-1002;Compra;USDT;PEN;400,00;3,705;1.482,00;0;Completado;15/09/2026 09:00;Luis
ED-1003;Venta;USDT;PEN;250,00;3,770;942,50;0;Pendiente;15/09/2026 11:00;Rosa
ED-1004;Venta;USDT;PEN;250,00;3,768;942,00;0;Completado;16/09/2026 10:30;Carla`;
  await post('/import/file', { filename: 'binance_p2p.csv', content: binance, commit: true });
  await post('/import/file', { filename: 'eldorado.csv', content: eldorado, commit: true });
  await post('/costs', { date: '2026-09-03 17:00', pair: 'USDT/PEN', asset: 'USDT', amount: 1, description: 'Retiro Binance → El Dorado (red TRC20)', exchange: 'Binance' });
  await post('/costs', { date: '2026-09-30 12:00', pair: 'USDT/PEN', asset: 'PEN', amount: 4.5, description: 'Comisiones bancarias del mes' });
  const r = await fetch(`${B}/export/excel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: '2026-09-01', to: '2026-09-30', userName: 'Ejemplo' }) });
  fs.writeFileSync(path.join(__dirname, 'ArbiTrack_ejemplo.xlsx'), Buffer.from(await r.arrayBuffer()));
  const pdf = await fetch(`${B}/export/pdf?from=2026-09-01&to=2026-09-30&userName=Ejemplo`);
  fs.writeFileSync(path.join(__dirname, 'ArbiTrack_ejemplo.pdf'), Buffer.from(await pdf.arrayBuffer()));
  const st = await fetch(`${B}/stats`).then((x) => x.json());
  console.log(JSON.stringify(st.byPair.map((p) => ({ pair: p.pair, net: p.netProfit, gross: p.grossProfit, fees: p.fees, other: p.otherCosts, inv: p.inventoryQty })), null, 1));
  srv.close();
});

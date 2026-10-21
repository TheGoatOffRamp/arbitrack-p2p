'use strict';
// Lectura de Excel 97-2003 (.xls, BIFF8 dentro de un archivo compuesto OLE) a una matriz de celdas.
// Bybit exporta su historial P2P en este formato. Solo se leen valores (texto, números, fechas, fórmulas ya calculadas).

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const END = 0xfffffffe, FREE = 0xffffffff;

const isXls = (buf) => buf.length >= 8 && buf.subarray(0, 8).equals(OLE_MAGIC);

/** Archivo compuesto (CFB): devuelve el contenido de un stream por nombre. */
function readCfbStream(buf, wanted) {
  const fail = (m) => { throw new Error(`Archivo .xls dañado o no válido (${m})`); };
  if (!isXls(buf) || buf.length < 512) fail('cabecera');
  const secSize = 1 << buf.readUInt16LE(0x1e), miniSize = 1 << buf.readUInt16LE(0x20);
  if (secSize !== 512 && secSize !== 4096) fail('tamaño de sector');
  const sector = (id) => {
    const off = (id + 1) * secSize;
    if (off >= buf.length) fail('sector fuera del archivo');
    return buf.subarray(off, Math.min(off + secSize, buf.length));
  };
  const maxSteps = Math.ceil(buf.length / 64) + 10;
  const chain = (start, table) => {
    const out = [];
    for (let id = start, n = 0; id !== END && id !== FREE; id = table[id], n++) {
      if (n > maxSteps || id >= table.length) fail('cadena de sectores');
      out.push(id);
    }
    return out;
  };

  // Tabla FAT: ubicaciones en la cabecera (109) y en la cadena DIFAT.
  const fatIds = [];
  for (let i = 0; i < 109; i++) { const id = buf.readUInt32LE(0x4c + i * 4); if (id !== FREE && id !== END) fatIds.push(id); }
  for (let id = buf.readUInt32LE(0x44), n = buf.readUInt32LE(0x48); n > 0 && id !== END && id !== FREE; n--) {
    const s = sector(id);
    for (let i = 0; i < secSize / 4 - 1; i++) { const x = s.readUInt32LE(i * 4); if (x !== FREE && x !== END) fatIds.push(x); }
    id = s.readUInt32LE(secSize - 4);
  }
  const fat = [];
  for (const id of fatIds) { const s = sector(id); for (let i = 0; i + 4 <= s.length; i += 4) fat.push(s.readUInt32LE(i)); }
  const readChain = (start, size) => Buffer.concat(chain(start, fat).map(sector)).subarray(0, size);

  // Directorio
  const dir = readChain(buf.readUInt32LE(0x30), Infinity);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = Math.min(dir.readUInt16LE(o + 0x40), 64);
    entries.push({ name: dir.toString('utf16le', o, o + Math.max(nameLen - 2, 0)), type: dir[o + 0x42],
      start: dir.readUInt32LE(o + 0x74), size: dir.readUInt32LE(o + 0x78) });
  }
  const root = entries.find((e) => e.type === 5);
  const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name));
  if (!entry) return null;
  if (entry.size >= buf.readUInt32LE(0x38)) return readChain(entry.start, entry.size);
  // Streams pequeños: van en el "mini stream" del directorio raíz.
  const miniFat = [];
  for (const id of chain(buf.readUInt32LE(0x3c), fat)) { const s = sector(id); for (let i = 0; i + 4 <= s.length; i += 4) miniFat.push(s.readUInt32LE(i)); }
  const ministream = readChain(root.start, root.size);
  return Buffer.concat(chain(entry.start, miniFat).map((id) => ministream.subarray(id * miniSize, (id + 1) * miniSize))).subarray(0, entry.size);
}

/** Cadena Unicode de BIFF8 que puede continuar en registros CONTINUE (cada tramo trae su propio indicador de 8/16 bits). */
class Segments {
  constructor(parts) { this.parts = parts; this.i = 0; this.o = 0; }
  get cur() { return this.parts[this.i]; }
  next() { this.i++; this.o = 0; if (!this.cur) throw new Error('Archivo .xls dañado (texto incompleto)'); }
  ensure(n) { if (this.o + n > this.cur.length) this.next(); }
  u8() { this.ensure(1); return this.cur[this.o++]; }
  u16() { this.ensure(2); const v = this.cur.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { this.ensure(4); const v = this.cur.readUInt32LE(this.o); this.o += 4; return v; }
  skip(n) { while (n > 0) { if (this.o >= this.cur.length) this.next(); const k = Math.min(n, this.cur.length - this.o); this.o += k; n -= k; } }
  string() {
    const cch = this.u16();
    const flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    let wide = flags & 0x01, out = '', left = cch;
    while (left > 0) {
      if (this.o >= this.cur.length) { this.next(); wide = this.u8() & 0x01; }
      const fit = Math.min(left, Math.floor((this.cur.length - this.o) / (wide ? 2 : 1)));
      if (fit <= 0) { this.next(); wide = this.u8() & 0x01; continue; }
      out += this.cur.toString(wide ? 'utf16le' : 'latin1', this.o, this.o + fit * (wide ? 2 : 1));
      this.o += fit * (wide ? 2 : 1); left -= fit;
    }
    this.skip(runs * 4 + ext);
    return out;
  }
}

const shortString = (d, o) => new Segments([d.subarray(o)]).string();

function rkValue(rk) {
  let v;
  if (rk & 0x02) v = rk >> 2;
  else { const b = Buffer.alloc(8); b.writeUInt32LE(rk & 0xfffffffc, 4); v = b.readDoubleLE(0); }
  return rk & 0x01 ? v / 100 : v;
}

// Formatos de fecha integrados de Excel y detección en formatos propios (ignorando texto entre comillas y colores).
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const looksLikeDate = (f) => /[ydhs]|m(?!\])/i.test(String(f).replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));

/** @returns {{ delimiter: null, sheet: string, rows: any[][] }} */
function parseXls(buf) {
  const wb = readCfbStream(buf, ['Workbook']);
  if (!wb) {
    if (readCfbStream(buf, ['Book'])) throw new Error('Formato Excel 95 no soportado: abre el archivo y guárdalo como .xlsx o CSV');
    throw new Error('El archivo .xls no contiene un libro de Excel');
  }

  const sst = [], formats = new Map(), xfs = [], sheetNames = [], sheets = [];
  let date1904 = false, sheet = null, pendingString = null;
  const set = (r, c, v) => { if (!sheet) return; (sheet.cells[r] ||= [])[c] = v; };
  const num = (r, c, xf, v) => {
    const fmt = xfs[xf];
    if (fmt !== undefined && (DATE_FORMATS.has(fmt) || (formats.has(fmt) && looksLikeDate(formats.get(fmt))))) {
      const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      return set(r, c, new Date(Math.round(base + v * 86400000)));
    }
    set(r, c, v);
  };

  for (let o = 0; o + 4 <= wb.length;) {
    const id = wb.readUInt16LE(o), len = wb.readUInt16LE(o + 2);
    const d = wb.subarray(o + 4, o + 4 + len);
    o += 4 + len;
    switch (id) {
      case 0x0809: // BOF
        if (d.readUInt16LE(2) === 0x0010) { sheet = { name: sheetNames[sheets.length] || `Hoja${sheets.length + 1}`, cells: [] }; sheets.push(sheet); } else sheet = null;
        break;
      case 0x000a: sheet = null; break; // EOF
      case 0x002f: throw new Error('El archivo .xls está protegido con contraseña; quítala o guárdalo como .xlsx');
      case 0x0022: date1904 = d.readUInt16LE(0) === 1; break;
      case 0x0085: sheetNames.push(shortString8(d, 6)); break; // BOUNDSHEET
      case 0x041e: formats.set(d.readUInt16LE(0), shortString(d, 2)); break; // FORMAT
      case 0x00e0: xfs.push(d.readUInt16LE(2)); break; // XF
      case 0x00fc: { // SST + CONTINUE
        const parts = [d.subarray(8)];
        while (o + 4 <= wb.length && wb.readUInt16LE(o) === 0x003c) {
          const l = wb.readUInt16LE(o + 2); parts.push(wb.subarray(o + 4, o + 4 + l)); o += 4 + l;
        }
        const seg = new Segments(parts), unique = d.readUInt32LE(4);
        for (let i = 0; i < unique; i++) sst.push(seg.string());
        break;
      }
      case 0x00fd: set(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? ''); break; // LABELSST
      case 0x0204: set(d.readUInt16LE(0), d.readUInt16LE(2), shortString(d, 6)); break; // LABEL
      case 0x0203: num(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), d.readDoubleLE(6)); break; // NUMBER
      case 0x027e: num(d.readUInt16LE(0), d.readUInt16LE(2), d.readUInt16LE(4), rkValue(d.readUInt32LE(6))); break; // RK
      case 0x00bd: { // MULRK
        const r = d.readUInt16LE(0);
        for (let c = d.readUInt16LE(2), p = 4; p + 6 <= d.length - 2; p += 6, c++) num(r, c, d.readUInt16LE(p), rkValue(d.readUInt32LE(p + 2)));
        break;
      }
      case 0x0205: set(d.readUInt16LE(0), d.readUInt16LE(2), d[7] ? '' : !!d[6]); break; // BOOLERR
      case 0x0006: { // FORMULA: se usa el resultado guardado
        const r = d.readUInt16LE(0), c = d.readUInt16LE(2);
        if (d.readUInt16LE(12) !== 0xffff) num(r, c, d.readUInt16LE(4), d.readDoubleLE(6));
        else if (d[6] === 0) pendingString = [r, c];
        else if (d[6] === 1) set(r, c, !!d[8]);
        break;
      }
      case 0x0207: if (pendingString) { set(...pendingString, shortString(d, 0)); pendingString = null; } break; // STRING
      default: break;
    }
  }

  const tables = sheets.map((s) => {
    const width = Math.max(0, ...s.cells.filter(Boolean).map((r) => r.length));
    const rows = s.cells.filter((r) => r && r.some((v) => v !== undefined && String(v).trim() !== ''))
      .map((r) => Array.from({ length: width }, (_, i) => (r[i] === undefined ? '' : r[i])));
    return { name: s.name, rows };
  });
  const best = tables.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!best || !best.rows.length) throw new Error('El archivo .xls no contiene filas');
  return { delimiter: null, sheet: best.name, rows: best.rows };
}

// BOUNDSHEET usa ShortXLUnicodeString (longitud de 1 byte).
function shortString8(d, o) {
  const cch = d[o], wide = d[o + 1] & 0x01;
  return d.toString(wide ? 'utf16le' : 'latin1', o + 2, o + 2 + cch * (wide ? 2 : 1));
}

module.exports = { parseXls, isXls, readCfbStream };

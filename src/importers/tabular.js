'use strict';
// Lectura de CSV (RFC 4180 tolerante) y XLSX a una matriz de celdas.
const ExcelJS = require('exceljs');

const DELIMS = [',', ';', '\t', '|'];

/** Cuenta delimitadores fuera de comillas en una línea. */
function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = { d: ',', score: -1 };
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d)).filter((c) => c > 0);
    if (!counts.length) continue;
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    const [mode, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    const score = times * 1000 + mode; // consistencia primero, luego número de columnas
    if (score > best.score) best = { d, score };
  }
  return best.d;
}

function parseCsv(input, delimiter) {
  let text = String(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.replace(/[\s=]/g, '') === '') { q = true; cell = cell.replace(/[^=]/g, ''); continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += ch;
  }
  if (q) throw new Error('CSV mal formado: comillas sin cerrar');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return { delimiter: d, rows: rows.filter((r) => r.some((c) => String(c).trim() !== '')) };
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if (v.text !== undefined) return String(v.text);
    if (v.error) return '';
  }
  return v;
}

async function parseXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellValue(r.getCell(c).value));
      rows.push(vals);
    });
    sheets.push({ name: ws.name, rows });
  });
  const best = sheets.sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!best || !best.rows.length) throw new Error('El archivo XLSX no contiene filas');
  return { delimiter: null, sheet: best.name, rows: best.rows };
}

module.exports = { parseCsv, parseXlsx, detectDelimiter };

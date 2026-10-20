'use strict';
const { D } = require('./money');
const { cleanCell } = require('./dates');

/**
 * Detecta el separador decimal de una columna completa.
 * Devuelve '.', ',' o null (sin evidencia) o 'INCONSISTENT'.
 */
function detectDecimalSeparator(values) {
  let dot = false, comma = false;
  for (const raw of values) {
    const s = stripUnits(cleanCell(raw)).num;
    if (!s) continue;
    const li = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
    if (s.includes('.') && s.includes(',')) {
      if (s[li] === '.') dot = true; else comma = true;
      continue;
    }
    const m = /^-?\d+([.,])(\d+)$/.exec(s);
    if (m && m[2].length !== 3) { if (m[1] === '.') dot = true; else comma = true; }
    // '1.234.567' o '1,234,567': solo miles → evidencia del separador opuesto
    if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) comma = true;
    if (/^-?\d{1,3}(,\d{3}){2,}$/.test(s)) dot = true;
  }
  if (dot && comma) return 'INCONSISTENT';
  return dot ? '.' : comma ? ',' : null;
}

function stripUnits(s) {
  // Quita símbolos/códigos de moneda: "3.75 PEN", "S/ 1,200.00", "USDT 100", "$1,000"
  let unit = null;
  let t = s.replace(/^\((.*)\)$/, '-$1');
  const mm = /^([A-Za-z]{2,6}|S\/\.?|US\$|\$|€)\s*(.*)$/.exec(t);
  if (mm && /\d/.test(mm[2])) { unit = mm[1]; t = mm[2]; }
  const mt = /^(.*?)\s*([A-Za-z]{2,6})$/.exec(t);
  if (mt && /\d/.test(mt[1])) { unit = mt[2]; t = mt[1]; }
  t = t.replace(/[\s ]/g, '').replace(/^\+/, '');
  if (/^-?[$€]/.test(t)) t = t.replace(/[$€]/, '');
  return { num: t, unit: unit ? unit.toUpperCase() : null };
}

/**
 * Convierte un texto numérico de exportación a string decimal exacto.
 * @param decimal '.' | ',' | null (auto por valor)
 * @returns {{ok:true, value:string, unit:string|null} | {ok:false, error:string}}
 */
function parseAmount(raw, decimal = null) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, error: 'número no finito' };
    return { ok: true, value: D(raw).toFixed(), unit: null };
  }
  const c = cleanCell(raw);
  if (c === '' || c === '-' || c === '--') return { ok: false, error: 'vacío', empty: true };
  const { num, unit } = stripUnits(c);
  let s = num;
  if (!/^-?[\d.,]+$/.test(s)) return { ok: false, error: `número no reconocido: "${c}"` };
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  let dec = decimal;
  if (hasDot && hasComma) {
    dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  } else if (!dec && (hasDot || hasComma)) {
    const sep = hasDot ? '.' : ',';
    const parts = s.replace('-', '').split(sep);
    if (parts.length > 2) dec = sep === '.' ? ',' : '.'; // separador repetido = miles
    else if (parts[1].length === 3 && parts[0].length <= 3 && parts[0] !== '0') {
      return { ok: false, error: `separador ambiguo en "${c}" (¿miles o decimales?)`, ambiguous: true };
    } else dec = sep;
  }
  dec = dec || '.';
  const thou = dec === '.' ? ',' : '.';
  if (s.includes(thou)) {
    const intPart = s.split(dec)[0].replace('-', '');
    if (!/^\d{1,3}([.,]\d{3})*$/.test(intPart)) return { ok: false, error: `agrupación de miles inválida en "${c}"` };
    s = s.split(thou).join('');
  }
  if (dec === ',') s = s.replace(',', '.');
  if ((s.match(/\./g) || []).length > 1) return { ok: false, error: `número mal formado: "${c}"` };
  try {
    return { ok: true, value: D(s).toFixed(), unit };
  } catch {
    return { ok: false, error: `número mal formado: "${c}"` };
  }
}

module.exports = { parseAmount, detectDecimalSeparator };

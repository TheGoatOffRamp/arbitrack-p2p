'use strict';
// Manejo de fechas: todo se guarda como instante UTC (ISO con Z y milisegundos).
// La hora "local" solo se usa para interpretar entradas sin zona y para presentar.
const DEFAULT_TZ = process.env.ARBITRACK_TZ || 'America/Lima';

const fmtCache = new Map();
function getFmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmtCache.get(tz);
}

function assertTz(tz) {
  try { getFmt(tz); return tz; } catch { throw new Error(`Zona horaria inválida: ${tz}`); }
}

/** Partes de fecha/hora en la zona `tz` para el instante `ms`. */
function zonedParts(ms, tz = DEFAULT_TZ) {
  const p = {};
  for (const { type, value } of getFmt(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second, ms: new Date(ms).getUTCMilliseconds(),
  };
}

/** Desfase (minutos) de `tz` respecto de UTC en el instante `ms`. Lima = -300. */
function tzOffsetMinutes(ms, tz = DEFAULT_TZ) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms);
  return Math.round((asUtc - ms) / 60000);
}

/** Convierte una hora de pared en `tz` al instante UTC correspondiente. */
function zonedToUtcMs(y, mo, d, h = 0, mi = 0, s = 0, msec = 0, tz = DEFAULT_TZ) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, msec);
  let ms = guess - tzOffsetMinutes(guess, tz) * 60000;
  const off2 = tzOffsetMinutes(ms, tz);
  ms = guess - off2 * 60000; // corrige cruces de horario de verano
  return ms;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DDTHH:mm' en hora local (campo `date` heredado que usa la webapp). */
function toLocalMinute(ms, tz = DEFAULT_TZ) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** 'YYYY-MM-DD HH:mm:ss' en hora local. */
function toLocalFull(ms, tz = DEFAULT_TZ) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Fecha para ExcelJS: un Date cuyos campos UTC == hora de pared local (Excel no tiene zonas). */
function toExcelDate(ms, tz = DEFAULT_TZ) {
  const p = zonedParts(ms, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

function validYMD(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim && y >= 2000 && y <= 2100;
}

/** Limpia artefactos típicos de exportaciones: tabs iniciales, comillas, apóstrofes de Excel. */
function cleanCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/^[\s\t'"=]+|[\s\t"]+$/g, '').replace(/ /g, ' ').trim();
}

const RE_ISO = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?\s*(AM|PM|a\.?\s?m\.?|p\.?\s?m\.?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?(?:\s*\(?(?:UTC|GMT)?([+-]\d{1,2})(?::?(\d{2}))?\)?)?$/i;
const RE_DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|a\.?\s?m\.?|p\.?\s?m\.?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i;

function applyAmPm(h, ampm) {
  if (!ampm) return h;
  const pm = /^p/i.test(ampm);
  if (h < 1 || h > 12) return NaN;
  if (pm && h < 12) return h + 12;
  if (!pm && h === 12) return 0;
  return h;
}

function offsetToMinutes(z) {
  if (!z) return null;
  if (/^(Z|UTC|GMT)$/i.test(z)) return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Interpreta una fecha de origen.
 * @param {*} value  texto, número epoch o Date (de un XLSX)
 * @param {object} o { tz, dateOrder: 'DMY'|'MDY', excelDateIsLocal }
 * @returns {{ok:true, ms:number, explicitZone:boolean} | {ok:false, error:string}}
 */
function parseSourceDate(value, o = {}) {
  const tz = o.tz || DEFAULT_TZ;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return { ok: false, error: 'fecha inválida' };
    // ExcelJS entrega las fechas de celda como UTC == hora de pared escrita en la hoja.
    const ms = zonedToUtcMs(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
      value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds(), value.getUTCMilliseconds(), tz);
    return { ok: true, ms, explicitZone: false };
  }
  if (typeof value === 'number' || /^\d{10}(\d{3})?$/.test(cleanCell(value))) {
    const n = Number(cleanCell(value));
    const ms = n < 1e11 ? n * 1000 : n; // segundos o milisegundos
    if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > Date.UTC(2100, 0, 1)) {
      return { ok: false, error: `epoch fuera de rango: ${value}` };
    }
    return { ok: true, ms, explicitZone: true };
  }
  const s = cleanCell(value);
  if (!s) return { ok: false, error: 'fecha vacía' };

  let m = RE_ISO.exec(s);
  let y, mo, d, h = 0, mi = 0, se = 0, frac = 0, ampm, zone;
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
    if (m[4] !== undefined) { h = +m[4]; mi = +m[5]; se = m[6] ? +m[6] : 0; frac = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0; }
    ampm = m[8];
    zone = m[9] || (m[10] ? `${m[10].startsWith('-') ? '-' : '+'}${pad(Math.abs(+m[10]))}:${m[11] || '00'}` : null);
  } else if ((m = RE_DMY.exec(s))) {
    const a = +m[1], b = +m[2];
    y = +m[3]; if (y < 100) y += 2000;
    const order = o.dateOrder || (a > 12 ? 'DMY' : b > 12 ? 'MDY' : null);
    if (!order) return { ok: false, error: `fecha ambigua (día/mes): "${s}". Indique el formato DMY o MDY.` };
    if (order === 'DMY') { d = a; mo = b; } else { mo = a; d = b; }
    if (m[4] !== undefined) { h = +m[4]; mi = +m[5]; se = m[6] ? +m[6] : 0; }
    ampm = m[7]; zone = m[8];
  } else {
    return { ok: false, error: `formato de fecha no reconocido: "${s}"` };
  }
  h = applyAmPm(h, ampm);
  if (!validYMD(y, mo, d) || !(h >= 0 && h < 24) || mi > 59 || se > 59) {
    return { ok: false, error: `fecha inválida: "${s}"` };
  }
  const off = offsetToMinutes(zone);
  if (zone && off === null) return { ok: false, error: `zona horaria no reconocida en "${s}"` };
  const ms = off !== null
    ? Date.UTC(y, mo - 1, d, h, mi, se, frac) - off * 60000
    : zonedToUtcMs(y, mo, d, h, mi, se, frac, tz);
  return { ok: true, ms, explicitZone: off !== null };
}

/**
 * Determina el orden día/mes de una columna completa (DMY/MDY) o null si no se puede.
 * Una columna es inconsistente si hay evidencia de ambos órdenes.
 */
function detectDateOrder(values) {
  let dmy = false, mdy = false;
  for (const v of values) {
    const m = RE_DMY.exec(cleanCell(v));
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  }
  if (dmy && mdy) return 'INCONSISTENT';
  return dmy ? 'DMY' : mdy ? 'MDY' : null;
}

/**
 * Límite de un rango de consulta. 'YYYY-MM-DD' se interpreta como día local completo.
 * Devuelve ms; para 'end' devuelve el primer ms del día siguiente (límite exclusivo).
 */
function rangeBoundary(v, kind, tz = DEFAULT_TZ) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dm) {
    const start = zonedToUtcMs(+dm[1], +dm[2], +dm[3], 0, 0, 0, 0, tz);
    if (kind === 'start') return start;
    return zonedToUtcMs(+dm[1], +dm[2], +dm[3] + 1, 0, 0, 0, 0, tz);
  }
  const r = parseSourceDate(s, { tz });
  if (!r.ok) throw new Error(`Fecha de rango inválida: ${s}`);
  return kind === 'end' ? r.ms + 1 : r.ms;
}

module.exports = {
  DEFAULT_TZ, assertTz, zonedParts, tzOffsetMinutes, zonedToUtcMs, toLocalMinute, toLocalFull,
  toExcelDate, parseSourceDate, detectDateOrder, rangeBoundary, cleanCell,
};

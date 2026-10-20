'use strict';
// Canal de importación: archivo → detección de exchange → mapeo de columnas → normalización → validación.
// No escribe en el libro: devuelve un análisis que el servidor registra solo si no hay bloqueos.
const { PROFILES, GENERIC, AMBIGUOUS, REQUIRED, ID_TIME, norm, mapHeaders, scoreProfile } = require('./profiles');
const { buildTrade, canonicalExchange } = require('../model');
const { detectDateOrder, cleanCell, DEFAULT_TZ, assertTz, toLocalFull, parseSourceDate } = require('../dates');
const { detectDecimalSeparator, parseAmount } = require('../numbers');
const { D } = require('../money');

const QUOTES = ['USDT', 'USDC', 'FDUSD', 'PEN', 'USD', 'EUR', 'BRL', 'ARS', 'CLP', 'COP', 'MXN', 'VES', 'BOB', 'BTC', 'ETH'];

function splitPair(raw) {
  const s = cleanCell(raw).toUpperCase();
  const m = /^([A-Z0-9]+)\s*[/\-_: ]\s*([A-Z0-9]+)$/.exec(s);
  if (m) return [m[1], m[2]];
  for (const q of QUOTES) if (s.endsWith(q) && s.length > q.length) return [s.slice(0, -q.length), q];
  return [null, null];
}

function chooseHeaderAndProfile(rows, opts) {
  const forced = opts.exchange ? canonicalExchange(opts.exchange) : null;
  const candidates = forced ? PROFILES.filter((p) => p.exchange === forced) : PROFILES;
  let best = null, generic = null;
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const headers = rows[i].map((h) => (h instanceof Date ? '' : String(h)));
    if (headers.filter((h) => norm(h)).length < 3) continue;
    for (const p of candidates) {
      const s = scoreProfile(headers, p);
      const hint = !!(p.filenameHint && opts.filename && p.filenameHint.test(opts.filename));
      const score = s.sig + (hint ? 0.25 : 0);
      if (!best || score > best.score || (score === best.score && s.mapped > best.mapped)) {
        best = { row: i, profile: p, score, sig: s.sig, mapped: s.mapped, headers, hint };
      }
    }
    const g = Object.keys(mapHeaders(headers, GENERIC)).length;
    if (!generic || g > generic.mapped) generic = { row: i, profile: GENERIC, score: 0, sig: 0, mapped: g, headers };
  }
  const known = best && (best.sig >= 0.75 || (best.sig >= 0.5 && best.hint) || (forced && best.sig >= 0.4));
  if (!known) return generic ? { ...generic, fallback: !!best } : null;
  // Empate entre perfiles conocidos → no se adivina
  if (!forced && !best.hint) {
    const ties = PROFILES.filter((p) => p !== best.profile && scoreProfile(best.headers, p).sig === best.sig);
    if (ties.length) best.tie = [best.profile.exchange, ...ties.map((t) => t.exchange)];
  }
  return best;
}

/**
 * @param {Array<Array>} rows  matriz de celdas (de CSV o XLSX)
 * @param {object} opts { filename, exchange, mapping:{field: headerName}, tz, dateOrder, decimal, onlyPairs:[..] }
 */
function analyze(rows, opts = {}) {
  const tzGiven = opts.tz ? assertTz(opts.tz) : null;
  const out = { status: 'ok', detection: null, mapping: {}, options: {}, needs: [], blocking: [], warnings: [],
    trades: [], rejected: [], issues: [], filtered: [], summary: {} };
  const det = chooseHeaderAndProfile(rows, opts);
  if (!det) { out.status = 'error'; out.blocking.push('No se encontró una fila de encabezados en el archivo.'); return out; }
  const { profile, headers } = det;
  out.detection = {
    profile: profile.id, exchange: opts.exchange ? canonicalExchange(opts.exchange) : profile.exchange,
    headerRow: det.row + 1, confidence: Math.min(1, det.sig + (det.hint ? 0.25 : 0)), headers,
    note: det.fallback ? 'Los encabezados no coinciden con ningún formato conocido; se usa el perfil genérico.' : null,
  };
  if (det.tie) {
    out.status = 'needs_input';
    out.needs.push({ field: 'exchange', message: `Los encabezados coinciden con varios exchanges (${det.tie.join(', ')}). Indique el exchange.`, options: det.tie });
    return out;
  }

  // Mapeo: perfil + correcciones explícitas del usuario ({campo: 'Nombre de columna'})
  const map = mapHeaders(headers, profile);
  const nh = headers.map(norm);
  for (const [field, header] of Object.entries(opts.mapping || {})) {
    if (header === null || header === '') { delete map[field]; continue; }
    const idx = nh.indexOf(norm(header));
    if (idx < 0) { out.blocking.push(`Mapeo: la columna "${header}" no existe en el archivo.`); continue; }
    map[field] = idx;
  }
  out.mapping = Object.fromEntries(Object.entries(map).map(([f, i]) => [f, headers[i]]));

  const exchangeFixed = out.detection.exchange;
  const missing = REQUIRED.filter((f) => map[f] === undefined && !(f === 'status' && profile.statusFromCompletion && map.completedAt !== undefined));
  if (map.pair === undefined && (map.crypto === undefined || map.fiat === undefined)) missing.push('crypto+fiat (o par)');
  const nums = ['amount', 'price', 'total'].filter((f) => map[f] !== undefined).length;
  if (nums < 2) missing.push('al menos dos de: cantidad cripto, precio, total fiat');
  if (!exchangeFixed && map.exchange === undefined) missing.push('exchange');
  if (missing.length) {
    const unmapped = headers.filter((h, i) => !Object.values(map).includes(i) && norm(h));
    out.status = 'needs_input';
    out.needs.push({
      field: 'mapping', missing,
      message: `Faltan columnas obligatorias: ${missing.join(', ')}. Indique a qué columna corresponde cada campo.`,
      unmappedHeaders: unmapped,
      ambiguousHeaders: unmapped.filter((h) => AMBIGUOUS.has(norm(h))),
    });
    return out;
  }

  const body = rows.slice(det.row + 1);
  const col = (f) => body.map((r) => r[map[f]]);

  // Orden día/mes para toda la columna
  let dateOrder = opts.dateOrder || null;
  if (!dateOrder) {
    const d = detectDateOrder(col('date'));
    if (d === 'INCONSISTENT') { out.blocking.push('La columna de fecha mezcla formatos día/mes y mes/día.'); }
    else dateOrder = d;
  }
  out.options.dateOrder = dateOrder;

  // ── Zona horaria ──
  // Prioridad: la indicada por el usuario > la deducida del ID de orden (hora codificada por el exchange)
  //            > la indicada en el encabezado ("Time (UTC-05:00)") > hora de Lima.
  const rawDateHeader = String(headers[map.date] || '');
  let headerTz = null;
  const hz = /\b(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i.exec(rawDateHeader);
  if (hz && (!hz[3] || hz[3] === '00')) headerTz = offsetToTz((hz[1] === '-' ? -1 : 1) * Number(hz[2]) * 60);
  else if (!hz && /\b(UTC|GMT)\b/i.test(rawDateHeader)) headerTz = 'UTC';
  let idTz = null, idInfo = null;
  if (profile.idTime && map.orderId !== undefined) {
    idInfo = inferTzFromIds(body, map, ID_TIME[profile.idTime], dateOrder);
    if (idInfo && idInfo.agreement >= 0.9 && idInfo.samples >= 1) idTz = offsetToTz(idInfo.offsetMin);
  }
  const tz = tzGiven || idTz || headerTz || DEFAULT_TZ;
  out.options.tz = tz;
  out.options.tzSource = tzGiven ? 'usuario' : idTz ? 'id de orden' : headerTz ? 'encabezado' : 'supuesta';
  if (!tzGiven) {
    if (idTz) {
      out.options.tzNote = `Zona horaria del archivo verificada con la hora que el exchange codifica en el N° de orden (${idInfo.samples} órdenes: ${tzLabel(tz)}).`;
      if (headerTz && headerTz !== idTz) out.warnings.push(`El encabezado dice ${tzLabel(headerTz)} pero los N° de orden indican ${tzLabel(idTz)}; se usó ${tzLabel(idTz)}.`);
    } else if (headerTz) {
      out.options.tzNote = `Zona horaria tomada del encabezado "${rawDateHeader}" (${tzLabel(headerTz)}).`;
    } else {
      out.warnings.push(`El archivo no indica su zona horaria: las horas se interpretaron como hora de Lima. Compare una operación con el exchange; si no coincide, indique la zona horaria.`);
    }
  }

  // ── Números: separador decimal por columna ──
  // Usuario > evidencia de la propia columna > formato conocido del exchange. Si una columna quedó corrompida
  // (p. ej. un CSV abierto y re-guardado en Google Sheets/Excel con otra configuración regional), se intenta
  // reconstruirla verificando cantidad × precio = total; si no se puede demostrar, se bloquea.
  const NUMERIC = ['amount', 'price', 'total', 'fee', 'feeMaker', 'feeTaker'].filter((f) => map[f] !== undefined);
  const colDec = {}, parsed = {}, badCols = [];
  for (const f of NUMERIC) {
    const values = col(f);
    const det = opts.decimal || detectDecimalSeparator(values);
    colDec[f] = det === 'INCONSISTENT' ? null : (det || profile.decimal || null);
    parsed[f] = values.map((v) => (v === undefined || cleanCell(v) === '' ? { ok: false, empty: true } : parseAmount(v, colDec[f])));
    // Corrupción de columna = separadores contradictorios o ambiguos. Un texto no numérico suelto ("abc") es un
    // problema de ESA fila y se rechaza individualmente.
    const corrupt = parsed[f].filter((x) => !x.ok && !x.empty && /ambiguo|agrupación|mal formado/.test(x.error || '')).length;
    if (det === 'INCONSISTENT' || corrupt) badCols.push(f);
  }
  let repaired = null;
  const needsRepair = badCols.some((f) => f === 'amount' || f === 'total') || (map.amount !== undefined && map.total !== undefined && map.price !== undefined
    && mostlyInconsistent(parsed.amount, parsed.price, parsed.total));
  const swapped = needsRepair && map.amount !== undefined && map.total !== undefined && map.price !== undefined
    && swapFixes(parsed.amount, parsed.price, parsed.total);
  if (swapped) {
    out.blocking.push(`La mayoría de las filas no cuadra y cuadraría intercambiando las columnas "${headers[map.amount]}" y "${headers[map.total]}". Revise el mapeo de columnas.`);
  } else if (needsRepair && map.amount !== undefined && map.total !== undefined && map.price !== undefined && !badCols.includes('price')) {
    repaired = repairScaledColumns(col('amount'), col('total'), parsed.price);
    if (repaired.ok) {
      parsed.amount = repaired.amount; parsed.total = repaired.total;
      out.warnings.push(`Los números de "${headers[map.amount]}" y "${headers[map.total]}" venían alterados (el archivo fue abierto y guardado en Google Sheets o Excel con otra configuración regional). `
        + `Se reconstruyeron con ${repaired.dAmount} y ${repaired.dTotal} decimales y se verificó que cantidad × precio = total en ${repaired.matched} de ${repaired.rows} filas. `
        + 'Para máxima seguridad, importe el archivo original descargado del exchange sin abrirlo en otro programa.');
      out.options.repairedColumns = [headers[map.amount], headers[map.total]];
    } else {
      out.blocking.push(`Los números de las columnas "${headers[map.amount]}" y "${headers[map.total]}" no se pueden interpretar con seguridad (${repaired.reason}). `
        + 'Descargue de nuevo el archivo desde el exchange e impórtelo sin abrirlo en Excel/Google Sheets, o indique el separador decimal.');
    }
  } else if (badCols.length) {
    const f = badCols[0];
    out.blocking.push(`La columna "${headers[map[f]]}" tiene números ambiguos o mal formados (p. ej. "${cleanCell(col(f).find((v, i) => !parsed[f][i].ok && !parsed[f][i].empty))}"). Indique el separador decimal.`);
  }
  out.options.decimal = opts.decimal || (Object.values(colDec).every((d) => d === '.') ? '.' : Object.values(colDec).every((d) => d === ',') ? ',' : 'por columna');
  if (out.blocking.length) { out.status = 'error'; return out; }

  const onlyPairs = opts.onlyPairs && opts.onlyPairs.length ? new Set(opts.onlyPairs.map((p) => p.toUpperCase())) : null;
  const numStr = (f, i) => (parsed[f] && parsed[f][i] && parsed[f][i].ok ? parsed[f][i].value : undefined);

  body.forEach((r, i) => {
    const rowNo = det.row + 2 + i; // número de fila tal como se ve en Excel
    const get = (f) => (map[f] === undefined ? undefined : r[map[f]]);
    const raw = {};
    headers.forEach((h, k) => { if (norm(h)) raw[h] = r[k] instanceof Date ? r[k].toISOString() : r[k]; });
    if (!Object.values(raw).some((v) => cleanCell(v) !== '')) return;
    const derived = [];

    let crypto = get('crypto'), fiat = get('fiat');
    if (map.pair !== undefined && (!cleanCell(crypto) || !cleanCell(fiat))) [crypto, fiat] = splitPair(get('pair'));

    let fee = numStr('fee', i);
    if (map.feeMaker !== undefined || map.feeTaker !== undefined) {
      fee = [numStr('feeMaker', i), numStr('feeTaker', i)].filter(Boolean).reduce((a, v) => a.plus(v), D(fee || 0)).toFixed();
    }
    let feeAsset = get('feeAsset');
    if (!cleanCell(feeAsset)) {
      if (profile.feeAsset === 'crypto') feeAsset = crypto;
      else if (profile.feeAsset === 'fiat') feeAsset = fiat;
      else feeAsset = null;
    }

    let status = get('status');
    if (map.status === undefined && profile.statusFromCompletion) {
      const done = cleanCell(get('completedAt'));
      status = done ? 'completado' : '';
      derived.push(done ? `estado = completado (el archivo registra "Orden Completada" ${done})` : 'estado desconocido (sin fecha de completado)');
    }

    let price = numStr('price', i);
    const amount = numStr('amount', i), total = numStr('total', i);
    if (profile.roundedPrice && amount && total && D(amount).gt(0)) {
      const exact = D(total).div(amount);
      if (price && exact.minus(price).abs().div(exact).gt('0.01')) {
        out.issues.push({ row: rowNo, code: 'TASA_DIFERENTE', severity: 'warning', message: `La tasa del archivo (${price}) difiere más de 1% de total ÷ cantidad (${exact.toDecimalPlaces(6).toFixed()}).` });
      }
      if (price) derived.push(`precio = total ÷ cantidad (la tasa del archivo, ${price}, viene redondeada)`);
      price = exact.toDecimalPlaces(10).toFixed();
    }
    if (repaired && repaired.changedRows.has(i)) derived.push(`números reconstruidos: cantidad "${cleanCell(get('amount'))}" → ${amount}, total "${cleanCell(get('total'))}" → ${total}`);

    let payMethod = get('payMethod');
    if (profile.payMethodMap && profile.payMethodMap[cleanCell(payMethod)]) payMethod = profile.payMethodMap[cleanCell(payMethod)];

    const cand = {
      exchange: exchangeFixed || get('exchange'), orderId: get('orderId'), side: get('side'),
      crypto, fiat, amount, price, total, fee, feeAsset, status, date: get('date'),
      counterparty: get('counterparty'), payMethod, raw,
      feeUnknown: map.fee === undefined && map.feeMaker === undefined && !!profile.noFeeColumnNote,
    };
    const res = buildTrade(cand, {
      tz, dateOrder, decimal: '.', source: 'csv',
      sourceRef: { file: opts.filename || null, row: rowNo, profile: profile.id },
    });
    if (res.rejected) { out.rejected.push({ row: rowNo, reasons: res.rejected.reasons, raw }); return; }
    if (onlyPairs && !onlyPairs.has(res.trade.pair)) { out.filtered.push({ row: rowNo, pair: res.trade.pair }); return; }
    res.trade.derived.unshift(...derived);
    out.trades.push(res.trade);
    for (const iss of res.issues) out.issues.push({ row: rowNo, id: res.trade.id, ...iss });
  });

  // Control de mapeo: si la mayoría de filas no cuadra y al intercambiar cantidad↔total sí cuadra, el mapeo está invertido.
  const bad = out.trades.filter((t) => out.issues.some((x) => x.id === t.id && x.code === 'TOTAL_INCONSISTENTE' && x.severity === 'error'));
  if (out.trades.length >= 3 && bad.length / out.trades.length >= 0.5) {
    const swapOk = bad.filter((t) => D(t.total).times(t.price).minus(t.amount).abs().lte(D(t.amount).times('0.002').plus('0.01'))).length;
    out.blocking.push(swapOk / bad.length >= 0.8
      ? `El ${Math.round(bad.length / out.trades.length * 100)}% de las filas no cuadra y cuadraría intercambiando las columnas "${out.mapping.amount}" y "${out.mapping.total}". Revise el mapeo.`
      : `El ${Math.round(bad.length / out.trades.length * 100)}% de las filas tiene cantidad × precio ≠ total. Revise el mapeo de columnas antes de importar.`);
  }

  const by = (k) => out.trades.reduce((a, t) => ((a[t[k]] = (a[t[k]] || 0) + 1), a), {});
  out.summary = {
    dataRows: body.length, accepted: out.trades.length, rejected: out.rejected.length, filteredByPair: out.filtered.length,
    byPair: by('pair'), byStatus: by('status'), bySide: by('side'),
    firstOperation: out.trades[0] ? { orderId: out.trades[0].orderId, sourceValue: out.trades[0].raw[out.mapping.date], interpretedAs: `${toLocalFull(Date.parse(out.trades[0].dateUtc), DEFAULT_TZ)} (hora de Lima)` } : null,
  };
  if (out.blocking.length) out.status = 'error';
  else if (out.rejected.length || out.issues.some((i) => i.severity !== 'info')) out.status = 'ok_with_issues';
  return out;
}


function offsetToTz(min) {
  if (min === -300) return 'America/Lima';
  if (min === 0) return 'UTC';
  if (min % 60 !== 0) return null;
  const h = min / 60;
  return `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`; // los nombres Etc/GMT tienen el signo invertido
}
function tzLabel(tz) {
  if (tz === 'America/Lima') return 'hora de Lima (UTC−5)';
  if (tz === 'UTC') return 'UTC';
  const m = /^Etc\/GMT([+-])(\d+)$/.exec(tz || '');
  return m ? `UTC${m[1] === '-' ? '+' : '−'}${m[2]}` : tz;
}

/** Deduce el desfase horario comparando la hora del archivo con la hora codificada en el ID de cada orden. */
function inferTzFromIds(body, map, idFn, dateOrder) {
  if (!idFn) return null;
  const counts = new Map();
  let samples = 0;
  for (const r of body.slice(0, 500)) {
    const id = cleanCell(r[map.orderId]);
    const idMs = id ? idFn(id) : null;
    const wall = parseSourceDate(r[map.date], { tz: 'UTC', dateOrder });
    if (!idMs || !wall.ok || wall.explicitZone) continue;
    const off = Math.round((wall.ms - idMs) / 60000 / 15) * 15;
    if (Math.abs((wall.ms - idMs) / 60000 - off) > 3) continue; // la orden se creó segundos antes del ID
    counts.set(off, (counts.get(off) || 0) + 1);
    samples++;
  }
  if (!samples) return null;
  const [offsetMin, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { offsetMin, samples, agreement: n / samples };
}

function swapFixes(pa, pp, pt) {
  let n = 0, ok = 0;
  pa.forEach((a, i) => {
    if (!a.ok || !pp[i].ok || !pt[i].ok) return;
    n++;
    if (tolOk(D(pt[i].value), D(pp[i].value), D(a.value))) ok++;
  });
  return n >= 3 && ok / n >= 0.8;
}

const tolOk = (a, p, t) => a.times(p).minus(t).abs().lte(t.times('0.002').plus('0.01'));

function mostlyInconsistent(pa, pp, pt) {
  let n = 0, bad = 0;
  pa.forEach((a, i) => {
    if (!a.ok || !pp[i].ok || !pt[i].ok) return;
    n++;
    if (!tolOk(D(a.value), D(pp[i].value), D(pt[i].value))) bad++;
  });
  return n >= 3 && bad / n >= 0.5;
}

/**
 * Reconstruye columnas de cantidad y total cuyos separadores fueron destruidos (p. ej. "2903501" en vez de 290.3501).
 * Solo se acepta si:
 *  1) hay valores "ancla" inequívocos (un único separador seguido de 1, 2 o ≥4 dígitos, que no puede ser de miles)
 *     y todos indican la misma cantidad de decimales, y
 *  2) con esos decimales, cantidad × precio = total en ≥ 95 % de las filas.
 */
function repairScaledColumns(amountCol, totalCol, parsedPrice) {
  const digits = (v) => { const s = cleanCell(v); if (!s) return null; const neg = /^-|^\(/.test(s); const d = s.replace(/[^\d]/g, ''); return d ? (neg ? '-' : '') + d : null; };
  const anchorDec = (col) => {
    const ds = new Set();
    for (const v of col) {
      if (typeof v === 'number') continue;
      const m = /^-?\d+[.,](\d{1,2}|\d{4,})$/.exec(cleanCell(v).replace(/\s|[A-Za-z]/g, ''));
      if (m) ds.add(m[1].length);
    }
    return ds.size === 1 ? [...ds][0] : ds.size > 1 ? 'CONFLICT' : null;
  };
  const scale = (dg, d) => (dg === null ? null : D(dg).div(D(10).pow(d)));
  const rows = amountCol.length;
  const test = (dA, dT) => {
    let matched = 0, usable = 0;
    for (let i = 0; i < rows; i++) {
      const a = scale(digits(amountCol[i]), dA), t = scale(digits(totalCol[i]), dT), p = parsedPrice[i];
      if (a === null || t === null || !p.ok) continue;
      usable++;
      if (tolOk(a, D(p.value), t)) matched++;
    }
    return { matched, usable };
  };
  let aA = anchorDec(amountCol), aT = anchorDec(totalCol);
  if (aA === 'CONFLICT' || aT === 'CONFLICT') return { ok: false, reason: 'los valores muestran distintas cantidades de decimales' };
  if (aA === null && aT === null) return { ok: false, reason: 'no hay ningún valor inequívoco que permita saber dónde va el punto decimal' };
  let best = null;
  for (let dA = 0; dA <= 8; dA++) {
    if (aA !== null && dA !== aA) continue;
    for (let dT = 0; dT <= 8; dT++) {
      if (aT !== null && dT !== aT) continue;
      const r = test(dA, dT);
      if (!best || r.matched > best.matched) best = { dA, dT, ...r };
    }
  }
  if (!best || !best.usable || best.matched / best.usable < 0.95) {
    return { ok: false, reason: `solo ${best ? best.matched : 0} de ${best ? best.usable : 0} filas cuadran al reconstruir` };
  }
  const changedRows = new Set();
  const mk = (col, d) => col.map((v, i) => {
    const dg = digits(v);
    if (dg === null) return { ok: false, empty: true };
    const val = scale(dg, d).toFixed();
    const naive = parseAmount(v, '.');
    if (!naive.ok || !D(naive.value).eq(val)) changedRows.add(i);
    return { ok: true, value: val };
  });
  return { ok: true, amount: mk(amountCol, best.dA), total: mk(totalCol, best.dT), dAmount: best.dA, dTotal: best.dT, matched: best.matched, rows: best.usable, changedRows };
}

module.exports = { analyze, splitPair, repairScaledColumns, inferTzFromIds };

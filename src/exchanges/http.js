'use strict';
// Cliente HTTP con timeout, reintentos con retroceso exponencial y respeto de Retry-After.

class ApiError extends Error {
  constructor(message, info = {}) { super(message); this.name = 'ApiError'; Object.assign(this, info); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} o { method, headers, body, timeoutMs, retries, fetchImpl, label, sleepImpl }
 * @returns {Promise<any>} JSON parseado
 */
async function requestJson(url, o = {}) {
  const f = o.fetchImpl || globalThis.fetch;
  const retries = o.retries ?? 3;
  const timeoutMs = o.timeoutMs ?? 15000;
  const wait = o.sleepImpl || sleep;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { method: o.method || 'GET', headers: o.headers, body: o.body, signal: ctrl.signal });
      const text = await res.text();
      clearTimeout(timer);
      if (res.status === 429 || res.status === 418 || res.status >= 500) {
        const ra = Number(res.headers?.get?.('retry-after'));
        lastErr = new ApiError(`${o.label || 'API'}: HTTP ${res.status}${res.status === 429 ? ' (límite de consultas)' : ''}`, { status: res.status, retryable: true });
        if (attempt < retries) { await wait(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt); continue; }
        throw lastErr;
      }
      let data;
      try { data = JSON.parse(text); } catch {
        throw new ApiError(`${o.label || 'API'}: respuesta no es JSON (HTTP ${res.status}). ${text.trim().startsWith('<') ? 'El endpoint no existe o requiere otro tipo de cuenta.' : ''}`.trim(), { status: res.status });
      }
      if (res.status >= 400) {
        throw new ApiError(`${o.label || 'API'}: HTTP ${res.status} — ${data.msg || data.message || data.retMsg || data.ret_msg || JSON.stringify(data).slice(0, 200)}`, { status: res.status, body: data });
      }
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof ApiError && !e.retryable) throw e;
      lastErr = e.name === 'AbortError'
        ? new ApiError(`${o.label || 'API'}: tiempo de espera agotado (${timeoutMs} ms)`, { retryable: true })
        : e instanceof ApiError ? e : new ApiError(`${o.label || 'API'}: error de red — ${e.message}`, { retryable: true });
      if (attempt < retries) { await wait(500 * 2 ** attempt); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

/** Divide [start, end) en ventanas de `days` días (los exchanges limitan el rango por consulta). */
function windows(startMs, endMs, days) {
  const out = [];
  const step = days * 86400000;
  for (let s = startMs; s < endMs; s += step) out.push([s, Math.min(s + step, endMs) - 1]);
  return out;
}

module.exports = { requestJson, ApiError, windows, sleep };

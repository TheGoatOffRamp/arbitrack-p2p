'use strict';
// Aritmética decimal exacta. Nunca usar + - * / de JS sobre montos.
const Decimal = require('decimal.js');
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

const D = (v) => {
  if (v instanceof Decimal) return v;
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(v);
};

const ZERO = new Decimal(0);

/** Suma una lista de valores (Decimal|string|number) de forma exacta. */
const sum = (arr, pick = (x) => x) => arr.reduce((acc, x) => acc.plus(D(pick(x))), ZERO);

/** Serializa un Decimal a string sin notación científica. */
const str = (d) => D(d).toFixed();

/** Número JS para presentación/Excel (redondeado a `dp` decimales). */
const num = (d, dp = 8) => Number(D(d).toDecimalPlaces(dp).toFixed());

module.exports = { Decimal, D, ZERO, sum, str, num };

/**
 * Exact decimal arithmetic on BigInt scaled integers. No IEEE754 anywhere (D11).
 * A Dec is `int / 10^scale`. Strings use plain notation (no exponent).
 */
import { IngestionError } from "./errors.ts";

export interface Dec {
  int: bigint;
  scale: number;
}

const RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export function parseDec(s: string): Dec {
  const m = RE.exec(s);
  if (!m) throw new IngestionError("INVALID_INPUT", false, { reason: "not a plain decimal string" });
  const frac = m[3] ?? "";
  const int = BigInt(`${m[2]}${frac}`) * (m[1] === "-" ? -1n : 1n);
  return { int, scale: frac.length };
}

export function isPlainDecimal(s: string): boolean {
  return RE.test(s);
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

export function rescale(d: Dec, scale: number): Dec {
  if (scale === d.scale) return d;
  if (scale > d.scale) return { int: d.int * pow10(scale - d.scale), scale };
  const div = pow10(d.scale - scale);
  return { int: d.int / div, scale }; // truncation toward zero; callers choose when to lose digits
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [rescale(a, s).int, rescale(b, s).int, s];
}

export const addDec = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return { int: x + y, scale: s };
};
export const subDec = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return { int: x - y, scale: s };
};
export const mulDec = (a: Dec, b: Dec): Dec => ({ int: a.int * b.int, scale: a.scale + b.scale });
export const cmpDec = (a: Dec, b: Dec): -1 | 0 | 1 => {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Division to a fixed number of fractional digits, rounding half away from zero. */
export function divDec(a: Dec, b: Dec, scale: number): Dec {
  if (b.int === 0n) throw new IngestionError("INVALID_INPUT", false, { reason: "division by zero" });
  // result = a.int/10^as / (b.int/10^bs) = a.int*10^bs / (b.int*10^as); want scale `scale`
  let num = a.int * pow10(b.scale + scale);
  let den = b.int * pow10(a.scale);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const absNum = neg ? -num : num;
  let q = absNum / den;
  if ((absNum % den) * 2n >= den) q += 1n;
  return { int: neg ? -q : q, scale };
}

export function formatDec(d: Dec): string {
  const neg = d.int < 0n;
  const abs = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, "0");
  const ip = d.scale === 0 ? abs : abs.slice(0, abs.length - d.scale);
  const fp = d.scale === 0 ? "" : abs.slice(abs.length - d.scale);
  const body = fp ? `${ip}.${fp}` : ip;
  return neg && d.int !== 0n ? `-${body}` : body;
}

/** Strip trailing fractional zeros ("1.2300" -> "1.23", "5.0" -> "5"). */
export function normalizeDecString(s: string): string {
  const d = parseDec(s);
  let { int, scale } = d;
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale--;
  }
  return formatDec({ int, scale });
}

export const addStr = (a: string, b: string): string => formatDec(addDec(parseDec(a), parseDec(b)));
export const sumStr = (xs: string[]): string =>
  formatDec(xs.map(parseDec).reduce(addDec, { int: 0n, scale: 0 }));

/** Smallest-unit integer string -> human decimal string (exact). `decimals` in [0, 80]. */
export function unitsToDecimal(units: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 80) {
    throw new IngestionError("INVALID_INPUT", false, { reason: "impossible decimal scale" });
  }
  if (!/^-?\d+$/.test(units))
    throw new IngestionError("INVALID_INPUT", false, { reason: "units must be an integer string" });
  return formatDec({ int: BigInt(units), scale: decimals });
}

/** Human decimal string -> smallest-unit integer string; throws if sub-unit precision would be lost. */
export function decimalToUnits(dec: string, decimals: number): string {
  const d = parseDec(dec);
  if (d.scale > decimals) {
    const extra = d.int % pow10(d.scale - decimals);
    if (extra !== 0n) throw new IngestionError("INVALID_INPUT", false, { reason: "sub-unit precision" });
  }
  return rescale(d, decimals).int.toString();
}

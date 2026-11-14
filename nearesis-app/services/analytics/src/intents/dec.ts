/** Exact decimal helpers on BigInt scaled integers (no IEEE754 on any money path). Strings in, strings out. */

const RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export interface D {
  int: bigint;
  scale: number;
}

export function parse(s: string): D {
  const m = RE.exec(s);
  if (!m) throw new Error(`not a plain decimal: ${s}`);
  const frac = m[3] ?? "";
  return { int: BigInt(`${m[2]}${frac}`) * (m[1] === "-" ? -1n : 1n), scale: frac.length };
}

export const ZERO: D = { int: 0n, scale: 0 };
const p10 = (n: number): bigint => 10n ** BigInt(n);

export function align(a: D, b: D): [bigint, bigint, number] {
  const s = Math.max(a.scale, b.scale);
  return [a.int * p10(s - a.scale), b.int * p10(s - b.scale), s];
}
export const add = (a: D, b: D): D => {
  const [x, y, s] = align(a, b);
  return { int: x + y, scale: s };
};
export const sub = (a: D, b: D): D => add(a, { int: -b.int, scale: b.scale });
export const mul = (a: D, b: D): D => ({ int: a.int * b.int, scale: a.scale + b.scale });
export const cmp = (a: D, b: D): -1 | 0 | 1 => {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** a / b rounded half away from zero to `scale` fractional digits. */
export function div(a: D, b: D, scale: number): D {
  if (b.int === 0n) throw new Error("division by zero");
  let num = a.int * p10(b.scale + scale);
  let den = b.int * p10(a.scale);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const n = neg ? -num : num;
  let q = n / den;
  if ((n % den) * 2n >= den) q += 1n;
  return { int: neg ? -q : q, scale };
}

export function format(d: D): string {
  const neg = d.int < 0n;
  const abs = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, "0");
  const ip = d.scale === 0 ? abs : abs.slice(0, abs.length - d.scale);
  const fp = d.scale === 0 ? "" : abs.slice(abs.length - d.scale);
  const body = fp ? `${ip}.${fp}` : ip;
  return neg && d.int !== 0n ? `-${body}` : body;
}

/** Trims trailing fractional zeros ("12.500000" -> "12.5", "3.000" -> "3"). */
export function norm(s: string): string {
  let { int, scale } = parse(s);
  while (scale > 0 && int % 10n === 0n) {
    int /= 10n;
    scale--;
  }
  return format({ int, scale });
}

export const sum = (xs: string[]): D => xs.map(parse).reduce(add, ZERO);

/** num/den as a fixed-scale ratio string; null when den is zero (never a made-up 0). */
export function ratio(
  num: string | number | bigint,
  den: string | number | bigint,
  scale = 6,
): string | null {
  const d = parse(String(den));
  if (d.int === 0n) return null;
  return format(div(parse(String(num)), d, scale));
}

/** Exact percentage change (cur - prev) / prev * 100 at 2 digits; null when prev is 0. */
export function pctChange(cur: string, prev: string): string | null {
  const p = parse(prev);
  if (p.int === 0n) return null;
  const diff = add(parse(cur), { int: -p.int, scale: p.scale });
  return format(div(mul(diff, { int: 100n, scale: 0 }), p, 2));
}

/** Exact decimal arithmetic on bigints. Metric values are never IEEE754 (S15). */
export interface Dec {
  n: bigint;
  s: number;
}

const P10 = (k: number) => 10n ** BigInt(k);

export function parseDec(text: string): Dec {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`not a decimal: ${text}`);
  const frac = m[3] ?? "";
  let n = BigInt(`${m[2]}${frac}`);
  let s = frac.length;
  const exp = m[4] ? Number(m[4]) : 0;
  if (exp > 0) n *= P10(exp);
  else if (exp < 0) s += -exp;
  if (m[1]) n = -n;
  return { n, s };
}

const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const s = Math.max(a.s, b.s);
  return [a.n * P10(s - a.s), b.n * P10(s - b.s), s];
};
export const addDec = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return { n: x + y, s };
};
export const subDec = (a: Dec, b: Dec): Dec => {
  const [x, y, s] = align(a, b);
  return { n: x - y, s };
};
export const mulDec = (a: Dec, b: Dec): Dec => ({ n: a.n * b.n, s: a.s + b.s });
export const cmpDec = (a: Dec, b: Dec): number => {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const isZero = (a: Dec) => a.n === 0n;

/** Division carried to `guard` extra digits (truncated); callers round once at the end. Returns null on a zero divisor. */
export function divDec(a: Dec, b: Dec, scale: number): Dec | null {
  if (b.n === 0n) return null;
  // (a.n / 10^a.s) / (b.n / 10^b.s) = a.n * 10^(b.s + scale - a.s) / b.n  at `scale` fractional digits
  const shift = b.s + scale - a.s;
  const num = shift >= 0 ? a.n * P10(shift) : a.n / P10(-shift);
  return { n: num / b.n, s: scale };
}

/** Rounds to `decimals` fractional digits. */
export function roundDec(a: Dec, decimals: number, mode: "half_even" | "truncate"): Dec {
  if (a.s <= decimals) return { n: a.n * P10(decimals - a.s), s: decimals };
  const div = P10(a.s - decimals);
  const q = a.n / div; // truncates toward zero
  const r = a.n % div;
  if (mode === "truncate" || r === 0n) return { n: q, s: decimals };
  const twice = (r < 0n ? -r : r) * 2n;
  const away = twice > div || (twice === div && (q < 0n ? -q : q) % 2n === 1n);
  return { n: away ? (a.n < 0n ? q - 1n : q + 1n) : q, s: decimals };
}

export function formatDec(a: Dec, decimals = a.s): string {
  const d = a.s === decimals ? a : { n: a.n * P10(Math.max(0, decimals - a.s)), s: Math.max(a.s, decimals) };
  const neg = d.n < 0n;
  const digits = (neg ? -d.n : d.n).toString().padStart(d.s + 1, "0");
  const int = d.s === 0 ? digits : digits.slice(0, -d.s);
  const frac = d.s === 0 ? "" : digits.slice(-d.s);
  return `${neg && (BigInt(int) !== 0n || /[1-9]/.test(frac)) ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

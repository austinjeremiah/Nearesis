/**
 * Exact USD handling for credits. Amounts travel as decimal strings with up to 6 places (micro-USD) and are only ever
 * handled as bigint here; no floating point touches a balance. Missing or malformed input is "unknown", never "$0.00".
 */

const DEC = /^\d+(\.\d+)?$/;
const MICRO_PLACES = 6;

export const CONTACT_EMAIL = 'connect@kaushikh.xyz';

export function isUsd(v: unknown): v is string {
  return typeof v === 'string' && DEC.test(v);
}

/** Micro-USD as bigint; digits past the 6th place are dropped (round down) or counted up (`up`). Null when unknown. */
export function toMicro(v: string | null | undefined, round: 'down' | 'up' = 'down'): bigint | null {
  if (!isUsd(v)) return null;
  const [w, f = ''] = v.split('.');
  const kept = f.slice(0, MICRO_PLACES).padEnd(MICRO_PLACES, '0');
  let micro = BigInt(w) * 1_000_000n + BigInt(kept);
  if (round === 'up' && /[1-9]/.test(f.slice(MICRO_PLACES))) micro += 1n;
  return micro;
}

export function fromMicro(m: bigint): string {
  const neg = m < 0n;
  const a = neg ? -m : m;
  const s = `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(MICRO_PLACES, '0')}`;
  return neg ? `-${s}` : s;
}

const group = (w: string) => w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * "$2.97" with exactly `decimals` places. `down` (default) never shows more than is there, which is what a remaining
 * balance needs; use `up` for what something cost. A non-zero amount that rounds to zero is "<$0.01" (or "$0.01" up).
 */
export function formatUsdExact(v: string | null | undefined, opts: { decimals?: number; round?: 'down' | 'up' } = {}): string {
  const micro = toMicro(v, opts.round);
  if (micro === null) return 'unknown';
  const decimals = Math.min(MICRO_PLACES, Math.max(0, opts.decimals ?? 2));
  const unit = 10n ** BigInt(MICRO_PLACES - decimals);
  let scaled = micro / unit;
  if (opts.round === 'up' && micro % unit > 0n) scaled += 1n;
  if (scaled === 0n && micro > 0n) return `<$${decimals > 0 ? `0.${'0'.repeat(decimals - 1)}1` : '1'}`;
  const base = 10n ** BigInt(decimals);
  const whole = group((scaled / base).toString());
  const frac = decimals > 0 ? `.${(scaled % base).toString().padStart(decimals, '0')}` : '';
  return `$${whole}${frac}`;
}

/** Between 2 and 6 places, trailing zeros trimmed down to 2: "$0.003300" -> "$0.0033", "$3.000000" -> "$3.00". Never rounds. */
export function formatUsdFull(v: string | null | undefined): string {
  const micro = toMicro(v);
  if (micro === null) return 'unknown';
  const [w, f] = fromMicro(micro).split('.');
  const frac = f.replace(/0+$/, '').padEnd(2, '0');
  return `$${group(w)}.${frac}`;
}

/** The allowance as a plain figure for sentences: "3.000000" -> "3", "2.5" -> "2.5". Null when unknown. */
export function allowanceLabel(v: string | null | undefined): string | null {
  const micro = toMicro(v);
  if (micro === null) return null;
  const [w, f] = fromMicro(micro).split('.');
  const frac = f.replace(/0+$/, '');
  return frac ? `${w}.${frac}` : w;
}

/** Exact sum; null when any input is unknown. */
export function sumUsd(...vals: (string | null | undefined)[]): string | null {
  let t = 0n;
  for (const v of vals) {
    const m = toMicro(v);
    if (m === null) return null;
    t += m;
  }
  return fromMicro(t);
}

/** a >= b (b counted up to the next micro-USD); null when either is unknown. */
export function usdAtLeast(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = toMicro(a);
  const y = toMicro(b, 'up');
  return x === null || y === null ? null : x >= y;
}

/** True when `available` is under 10% of `allowance`. Null when either is unknown or the allowance is zero. */
export function isLow(available: string | null | undefined, allowance: string | null | undefined): boolean | null {
  const a = toMicro(available);
  const g = toMicro(allowance);
  if (a === null || g === null || g === 0n) return null;
  return a * 10n < g;
}

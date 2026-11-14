/**
 * Exact NEAR <-> yoctoNEAR conversion. Amounts travel as decimal strings and are
 * only ever handled as bigint here; no floating point touches a balance.
 */

const YOCTO_PER_NEAR = 10n ** 24n;
const DECIMAL = /^\d+$/;

export const NEAR_DISPLAY_DECIMALS = 6;

/** True for a non-negative decimal integer string. */
export function isYocto(v: unknown): v is string {
  return typeof v === 'string' && DECIMAL.test(v);
}

/**
 * A NEAR amount typed by a person ("1", "0.25", "1.5") as a yocto string.
 * Returns null for anything that is not a plain positive decimal with at most
 * 24 fractional digits (no signs, exponents, separators or empty input).
 */
export function nearToYocto(input: string): string | null {
  const s = input.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const yocto = BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, '0'));
  return yocto > 0n ? yocto.toString() : null;
}

/**
 * yocto string -> NEAR with up to `decimals` places, trailing zeros trimmed.
 * `round: 'down'` (default) never shows more than is there; use 'up' for costs.
 * Missing or malformed input is "unknown", never "0". A non-zero amount that
 * rounds to zero shows as "<0.000001" (or "0.000001" when rounding up).
 */
export function formatNear(
  yocto: string | null | undefined,
  opts: { decimals?: number; round?: 'down' | 'up' } = {},
): string {
  if (!isYocto(yocto)) return 'unknown';
  const decimals = opts.decimals ?? NEAR_DISPLAY_DECIMALS;
  const unit = 10n ** BigInt(24 - decimals);
  const v = BigInt(yocto);
  let scaled = v / unit;
  const remainder = v % unit;
  if (remainder > 0n && opts.round === 'up') scaled += 1n;
  if (scaled === 0n && v > 0n) return `<${'0.'.concat('0'.repeat(decimals - 1), '1')}`;
  const base = 10n ** BigInt(decimals);
  const whole = scaled / base;
  const frac = (scaled % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${wholeStr}.${frac}` : wholeStr;
}

/** Sum of yocto strings; null when any input is unknown. */
export function addYocto(...vals: (string | null | undefined)[]): string | null {
  let t = 0n;
  for (const v of vals) {
    if (!isYocto(v)) return null;
    t += BigInt(v);
  }
  return t.toString();
}

/** a >= b for yocto strings; null when either is unknown. */
export function yoctoAtLeast(a: string | null | undefined, b: string | null | undefined): boolean | null {
  if (!isYocto(a) || !isYocto(b)) return null;
  return BigInt(a) >= BigInt(b);
}

/** Decode the challenge nonce (base64 or base64url) to exactly 32 bytes, or throw. */
export function decodeNonce(b64: string): Uint8Array {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) throw new Error('The challenge nonce is not valid base64.');
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std.padEnd(Math.ceil(std.length / 4) * 4, '='));
  if (bin.length !== 32) throw new Error(`The challenge nonce must be 32 bytes, got ${bin.length}.`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const EXPLORER_TX = 'https://testnet.nearblocks.io/txns/';
export function txUrl(hash: string): string {
  return `${EXPLORER_TX}${encodeURIComponent(hash)}`;
}

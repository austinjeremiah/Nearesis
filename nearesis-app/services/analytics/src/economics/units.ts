/**
 * Unit-safe exact quantities for NEAR economics (A18, D11). Gas units, yoctoNEAR and USD are distinct nominal types backed by
 * BigInt (or a scaled BigInt for USD); there is no implicit conversion and no IEEE754 anywhere. Mixing units is a TypeError
 * at runtime and a compile error in TypeScript. Conversions are explicit functions that name their method.
 */
export const YOCTO_PER_NEAR = 10n ** 24n;
const NEAR_DECIMALS = 24;

export class EconomicsUnitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EconomicsUnitError";
  }
}

declare const tag: unique symbol;
export type Gas = { readonly [tag]: "gas"; readonly units: bigint };
export type Yocto = { readonly [tag]: "yoctoNEAR"; readonly units: bigint };
/** USD as an integer count of 1e-`scale` dollars. */
export type Usd = { readonly [tag]: "USD"; readonly units: bigint; readonly scale: number };

const UINT = /^(\d+)(?:\.0+)?$/;
const parseUint = (s: string, what: string): bigint => {
  const m = UINT.exec(s);
  if (!m)
    throw new EconomicsUnitError(`${what} must be an unsigned integer string, got ${JSON.stringify(s)}`);
  return BigInt(m[1] as string);
};
const nonNeg = (v: bigint, what: string): bigint => {
  if (v < 0n) throw new EconomicsUnitError(`${what} cannot be negative`);
  return v;
};

function same<T extends { units: bigint }>(a: T, b: T, kind: string): void {
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null)
    throw new EconomicsUnitError(`${kind}: operands must be quantities`);
  const ta = (a as unknown as { [k: symbol]: unknown })[tagKey];
  const tb = (b as unknown as { [k: symbol]: unknown })[tagKey];
  if (ta !== tb) throw new EconomicsUnitError(`${kind}: operands have different units`);
}
const tagKey = Symbol("unit");
// runtime brand: attach the unit symbol on construction (the `declare const tag` above is type-level only)
const brand = <T extends object>(o: T, unit: string): T =>
  Object.defineProperty(o, tagKey, { value: unit, enumerable: false });
export const mkGas = (units: bigint): Gas => brand({ units: nonNeg(units, "gas") }, "gas") as unknown as Gas;
export const mkYocto = (units: bigint): Yocto =>
  brand({ units: nonNeg(units, "yoctoNEAR") }, "yoctoNEAR") as unknown as Yocto;
export const mkUsd = (units: bigint, scale: number): Usd => {
  if (!Number.isInteger(scale) || scale < 0 || scale > 30)
    throw new EconomicsUnitError("USD scale out of range");
  return brand({ units, scale }, "USD") as unknown as Usd;
};
export const parseGas = (s: string): Gas => mkGas(parseUint(s, "gas"));
export const parseYocto = (s: string): Yocto => mkYocto(parseUint(s, "yoctoNEAR"));

export const addGas = (a: Gas, b: Gas): Gas => (same(a, b, "addGas"), mkGas(a.units + b.units));
export const addYocto = (a: Yocto, b: Yocto): Yocto => (same(a, b, "addYocto"), mkYocto(a.units + b.units));
export const sumGas = (xs: Gas[]): Gas => xs.reduce(addGas, mkGas(0n));
export const sumYocto = (xs: Yocto[]): Yocto => xs.reduce(addYocto, mkYocto(0n));

export function plain(units: bigint, scale: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? s : `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
  return neg ? `-${body}` : body;
}
/** Exact NEAR decimal string (24 fractional digits) for a yoctoNEAR amount. */
export const yoctoToNear = (y: Yocto): string => (
  same(y, mkYocto(0n), "yoctoToNear"),
  plain(y.units, NEAR_DECIMALS)
);

/** Round-half-even integer division (non-negative operands). */
export function divRound(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new EconomicsUnitError("division by a non-positive denominator");
  const q = num / den;
  const r2 = (num % den) * 2n;
  return r2 > den || (r2 === den && q % 2n === 1n) ? q + 1n : q;
}

/** Ratio a/b as a decimal string with `scale` fractional digits (half-even). The numerator and denominator are plain counts. */
export function ratio(a: bigint, b: bigint, scale: number): string | null {
  if (b === 0n) return null; // undefined, never 0
  return plain(divRound(a * 10n ** BigInt(scale), b), scale);
}

/** A timestamped price source. `priceUsd` is an exact decimal string (USD per 1 NEAR). */
export interface PriceSource {
  provider: string;
  symbol: string;
  priceUsd: string;
  /** Timestamp the price applies to (candle bucket), ISO-8601 UTC. */
  priceTimestampUTC: string;
  /** How the single price was derived from the candle. */
  method: "coingecko_daily_close_utc" | "coingecko_daily_open_utc" | "coingecko_daily_mid_hl_utc";
}
export interface UsdValue {
  usd: string;
  scale: number;
  conversion: {
    method: PriceSource["method"];
    source: string;
    priceUsd: string;
    priceTimestampUTC: string;
    unitFrom: "yoctoNEAR";
    rounding: "half_even";
  };
}

/** yoctoNEAR -> USD: usd = yocto x priceUsd / 1e24, exact then rounded once (half-even) to `scale` digits. */
export function yoctoToUsd(y: Yocto, p: PriceSource, scale = 6): UsdValue {
  same(y, mkYocto(0n), "yoctoToUsd");
  const m = /^(\d+)(?:\.(\d+))?$/.exec(p.priceUsd);
  if (!m) throw new EconomicsUnitError("price must be a non-negative plain decimal string");
  if (!p.priceTimestampUTC || Number.isNaN(Date.parse(p.priceTimestampUTC)))
    throw new EconomicsUnitError("a USD conversion needs a timestamped price");
  const frac = m[2] ?? "";
  const priceInt = BigInt(`${m[1]}${frac}`);
  const num = y.units * priceInt * 10n ** BigInt(scale);
  const den = YOCTO_PER_NEAR * 10n ** BigInt(frac.length);
  return {
    usd: plain(divRound(num, den), scale),
    scale,
    conversion: {
      method: p.method,
      source: `${p.provider}:${p.symbol}`,
      priceUsd: p.priceUsd,
      priceTimestampUTC: p.priceTimestampUTC,
      unitFrom: "yoctoNEAR",
      rounding: "half_even",
    },
  };
}

/** Refuses to treat gas units as yoctoNEAR (and vice versa) without an explicit price: the only legal bridge. */
export function gasToYocto(g: Gas, yoctoPerGas: bigint): Yocto {
  same(g, mkGas(0n), "gasToYocto");
  if (yoctoPerGas <= 0n) throw new EconomicsUnitError("gas price must be positive");
  return mkYocto(g.units * yoctoPerGas);
}

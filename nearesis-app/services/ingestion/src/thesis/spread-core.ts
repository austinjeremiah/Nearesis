import { createHash } from "node:crypto";

/**
 * Pure parts of the user-paid spread and app-fee measurement (thesis "The Toll Booth Problem").
 * Nothing here touches a database, the network or the file system except `sha256Hex`.
 */

export const sha256Hex = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");

/** |in - out| above this share of the input value is a pricing artefact (reported separately, never dropped). */
export const ARTEFACT_SHARE_NUM = 1n;
export const ARTEFACT_SHARE_DEN = 5n; // 20 %

export const ROUTE_TYPES = [
  "stable_to_stable",
  "same_asset_cross_chain",
  "volatile_other",
  "unclassified",
] as const;
export type RouteType = (typeof ROUTE_TYPES)[number];

/** USD-pegged stablecoin symbols as observed in asset_registry (lower case, "(DEPRECATED)" suffix stripped). */
export const STABLE_SYMBOLS: readonly string[] = [
  "usdc",
  "usdt",
  "usdt0",
  "dai",
  "xdai",
  "usd1",
  "usdcx",
  "usdg",
  "usde",
  "usdf",
  "usad",
  "frax",
  "nrusdt",
];

/** Wrapped / bridged variants that count as the same asset family for the "same-asset bridge-like" group. */
export const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  weth: "eth",
  wnear: "near",
  wbtc: "btc",
  cbbtc: "btc",
  "btc(omni)": "btc",
  wnearkat: "nearkat",
};

/** Lower-cased symbol with a trailing "(DEPRECATED)" removed. */
export function baseSymbol(symbol: string): string {
  return symbol
    .trim()
    .replace(/\s*\(deprecated\)$/i, "")
    .toLowerCase();
}
export const familyOf = (symbol: string): string => {
  const b = baseSymbol(symbol);
  return FAMILY_ALIASES[b] ?? b;
};
export const isStable = (symbol: string): boolean => STABLE_SYMBOLS.includes(baseSymbol(symbol));

/** Same rules as the SQL `multiIf`, for tests and documentation. Null symbol = asset missing from the registry. */
export function classifyRoute(
  origin: { symbol: string; blockchain: string } | null,
  dest: { symbol: string; blockchain: string } | null,
): RouteType {
  if (!origin || !dest) return "unclassified";
  if (isStable(origin.symbol) && isStable(dest.symbol)) return "stable_to_stable";
  if (familyOf(origin.symbol) === familyOf(dest.symbol) && origin.blockchain !== dest.blockchain)
    return "same_asset_cross_chain";
  return "volatile_other";
}

/** Exact decimal helpers on integer-scaled BigInt (scale 1e12 is the explorer's USD precision). */
export const USD_SCALE = 12;
export function parseDecimalScaled(s: string, scale: number): bigint | null {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").slice(0, scale).padEnd(scale, "0");
  const v = BigInt(m[2]! + frac);
  return m[1] === "-" ? -v : v;
}
export function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const int = a.slice(0, a.length - scale);
  const frac = a.slice(a.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

/** Spread in basis points of the input value, rounded half away from zero to `dp` decimals, as an exact string. */
export function spreadBps(inUsd: bigint, outUsd: bigint, dp = 6): string | null {
  if (inUsd <= 0n) return null;
  const scale = 10n ** BigInt(dp);
  const num = (inUsd - outUsd) * 10000n * scale;
  const q = num / inUsd;
  const r = num % inUsd;
  const half = (r < 0n ? -r : r) * 2n >= inUsd ? (num < 0n ? -1n : 1n) : 0n;
  return formatScaled(q + half, dp);
}

export const isArtefact = (inUsd: bigint, outUsd: bigint): boolean => {
  const d = inUsd - outUsd;
  return (d < 0n ? -d : d) * ARTEFACT_SHARE_DEN > inUsd * ARTEFACT_SHARE_NUM;
};

/** Symbol lists as ClickHouse literals for the SQL generator. */
const lit = (xs: readonly string[]): string => `[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(",")}]`;

const symExpr = (c: string): string =>
  `lowerUTF8(trim(replaceRegexpOne(${c}, '\\\\s*\\\\(DEPRECATED\\\\)$', '')))`;
const famExpr = (c: string): string =>
  `transform(${symExpr(c)}, ${lit(Object.keys(FAMILY_ALIASES))}, ${lit(Object.values(FAMILY_ALIASES))}, ${symExpr(c)})`;

export type Grain = "day" | "month";

/** Row-level CTE shared by every spread query. SELECT-only. u = usable, a = artefact, c = clean. */
export function spreadBaseSql(): string {
  return `WITH reg AS (
  SELECT provider_asset_id, symbol_observed AS sym, blockchain AS chain
  FROM nearesis_live.asset_registry FINAL WHERE provider_id = 'intents-1click'
),
base AS (
  SELECT
    s.created_day AS d,
    s.amount_in_usd AS i,
    s.amount_out_usd AS o,
    i - o AS sp,
    (i IS NOT NULL AND o IS NOT NULL AND i > 0 AND o > 0) AS u,
    (u AND abs(sp) * 5 > i) AS a,
    (u AND NOT a) AS c,
    if(c, toFloat64(sp) * 10000 / toFloat64(i), NULL) AS bps,
    multiIf(
      ro.provider_asset_id = '' OR rd.provider_asset_id = '', 'unclassified',
      has(${lit(STABLE_SYMBOLS)}, ${symExpr("ro.sym")}) AND has(${lit(STABLE_SYMBOLS)}, ${symExpr("rd.sym")}), 'stable_to_stable',
      ${famExpr("ro.sym")} = ${famExpr("rd.sym")} AND ro.chain != rd.chain, 'same_asset_cross_chain',
      'volatile_other') AS rt
  FROM nearesis_live.intents_swaps AS s FINAL
  LEFT JOIN reg AS ro ON ro.provider_asset_id = s.origin_asset
  LEFT JOIN reg AS rd ON rd.provider_asset_id = s.destination_asset
  WHERE s.status = 'SUCCESS'
)`;
}

/**
 * Aggregate query. `byRoute=false` pools all route types into the single group 'all'.
 * Populations: success (all SUCCESS rows), usable (both USD marks known and > 0), artefact (|spread| > 20 % of input),
 * clean (usable and not artefact; used for every spread statistic).
 */
export function spreadAggSql(grain: Grain, byRoute: boolean): string {
  const period = grain === "day" ? "toString(d)" : "formatDateTime(d, '%Y-%m')";
  const grp = byRoute ? "rt" : "'all'";
  return `${spreadBaseSql()}
SELECT
  ${period} AS period,
  ${grp} AS grp,
  count() AS n_success,
  countIf(i IS NOT NULL) AS n_with_in_usd,
  toString(sumIf(i, i IS NOT NULL)) AS in_usd_success,
  countIf(u) AS n_usable,
  countIf(a) AS n_artefact,
  toString(sumIf(i, a)) AS artefact_in_usd,
  toString(sumIf(sp, a)) AS artefact_spread_usd,
  countIf(c) AS n_clean,
  toString(sumIf(i, c)) AS clean_in_usd,
  toString(sumIf(sp, c)) AS clean_spread_usd,
  toString(round(if(sumIf(i, c) > 0, sumIf(sp, c) * 10000 / sumIf(i, c), NULL), 6)) AS vw_mean_bps,
  quantilesExact(0.25, 0.5, 0.75)(bps) AS q,
  toString(round(q[2], 6)) AS median_bps,
  toString(round(q[1], 6)) AS p25_bps,
  toString(round(q[3], 6)) AS p75_bps,
  countIf(c AND sp < 0) AS n_negative_spread
FROM base
GROUP BY period, grp
ORDER BY period, grp`;
}

/** Calendar days between two ISO dates (inclusive) that are absent from `present`. */
export function missingDays(first: string, last: string, present: Iterable<string>): string[] {
  const have = new Set(present);
  const out: string[] = [];
  for (let t = Date.parse(first + "T00:00:00Z"); t <= Date.parse(last + "T00:00:00Z"); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!have.has(d)) out.push(d);
  }
  return out;
}

/* ---------------- app fees from archived raw Explorer pages ---------------- */

export interface RawFeeItem {
  key: string;
  day: string;
  status: string;
  inUsd: bigint | null;
  fees: { recipient: string; bps: number }[];
  referral: string | null;
}

/** Extracts the fields the app-fee scan needs from one raw Explorer item; null if it is not a swap record. */
export function toFeeItem(raw: unknown): RawFeeItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.depositAddress !== "string" || typeof r.createdAt !== "string") return null;
  const memo = typeof r.depositMemo === "string" ? r.depositMemo : "";
  const usd =
    typeof r.amountInUsd === "string" || typeof r.amountInUsd === "number" ? String(r.amountInUsd) : "";
  const fees: { recipient: string; bps: number }[] = [];
  if (Array.isArray(r.appFees))
    for (const f of r.appFees as unknown[]) {
      const o = f as { recipient?: unknown; fee?: unknown };
      if (typeof o?.recipient === "string" && typeof o.fee === "number")
        fees.push({ recipient: o.recipient, bps: o.fee });
    }
  return {
    key: `${r.depositAddress}|${memo}`,
    day: r.createdAt.slice(0, 10),
    status: typeof r.status === "string" ? r.status : "UNKNOWN",
    inUsd: usd === "" ? null : parseDecimalScaled(usd, USD_SCALE),
    fees,
    referral: typeof r.referral === "string" && r.referral !== "" ? r.referral : null,
  };
}

/** Fee in USD * 1e12 * 1e4 (i.e. input USD scaled 1e12 times bps), kept exact until formatted. */
export const feeUsdScaled4 = (inUsd: bigint, bps: number): bigint => inUsd * BigInt(bps);
export const formatFeeUsd = (scaled4: bigint): string => formatScaled(scaled4, USD_SCALE + 4);

export interface FeeAgg {
  swaps: number;
  swapsWithFee: number;
  swapsWithReferral: number;
  inUsd: bigint;
  inUsdWithFee: bigint;
  feeScaled4: bigint;
  /** swaps that carry an app fee but have no usable input USD mark */
  feeNoUsd: number;
}
export const emptyFeeAgg = (): FeeAgg => ({
  swaps: 0,
  swapsWithFee: 0,
  swapsWithReferral: 0,
  inUsd: 0n,
  inUsdWithFee: 0n,
  feeScaled4: 0n,
  feeNoUsd: 0,
});
export function addFeeItem(a: FeeAgg, it: RawFeeItem): void {
  a.swaps++;
  if (it.inUsd !== null) a.inUsd += it.inUsd;
  if (it.referral) a.swapsWithReferral++;
  if (it.fees.length) {
    a.swapsWithFee++;
    if (it.inUsd === null) a.feeNoUsd++;
    else {
      a.inUsdWithFee += it.inUsd;
      for (const f of it.fees) a.feeScaled4 += feeUsdScaled4(it.inUsd, f.bps);
    }
  }
}

/** Top-N by USD with exact shares (6 decimals) of the total. */
export function topShares(
  totals: Map<string, bigint>,
  n: number,
): { label: string; usdScaled4: bigint; share: string }[] {
  let total = 0n;
  for (const v of totals.values()) total += v;
  return [...totals.entries()]
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1))
    .slice(0, n)
    .map(([label, usdScaled4]) => ({
      label,
      usdScaled4,
      share: total === 0n ? "0" : formatScaled((usdScaled4 * 10n ** 6n) / total, 6),
    }));
}

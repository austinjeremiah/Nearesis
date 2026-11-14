/**
 * In-package NormalizedOutput literals used until B1's fx.snapshot.* fixtures land. Deterministic, no randomness.
 * Dates: 2026-10-01 .. 2026-10-10 (all before the private era at 2026-10-27).
 */
import type { NormalizedOutput, NormalizedTables } from "../../ingestion/src/normalized/types.ts";
import { canonicalJson, sha256 } from "./registry/registry.ts";

export const emptyTables = (): NormalizedTables => ({
  intents_swaps: [],
  quote_attempts: [],
  price_candles: [],
  near_daily_usage: [],
  near_signer_days: [],
  contract_interactions: [],
  source_coverage: [],
  quality_gaps: [],
  asset_aliases: [],
  contract_registry: [],
  watermarks: [],
});

export const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const H = (s: string) => sha256(s);
const SL = "SYNTHETIC" as const;
const V = 1_000;

export function wrap(snapshotId: string, tables: NormalizedTables): NormalizedOutput {
  return { snapshotId, mode: "replay", adapters: [], tables, digest: sha256(canonicalJson(tables)) };
}

type Swap = NormalizedTables["intents_swaps"][number];
export function swap(o: Partial<Swap> & { key: string; day: string }): Swap {
  return {
    swapKey: o.key,
    depositAddress: o.key,
    depositMemo: null,
    status: "SUCCESS",
    createdAtUTC: `${o.day}T12:00:00.000Z`,
    createdDay: o.day,
    originAsset: "nep141:wrap.near",
    destinationAsset: "nep141:usdc.near",
    canonicalOriginAsset: "NEAR",
    canonicalDestinationAsset: "USDC",
    amountIn: "1000000000000000000000000",
    amountOut: "5000000",
    amountFinal: true,
    amountInUsd: "5.000000000000000000",
    amountOutUsd: "5.000000000000000000",
    depositType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    referral: null,
    privacyEra: "public",
    publicSwapTxHashes: [],
    boundaryTxHashes: [],
    reconciliationLevel: "exact_public",
    sourceLabel: SL,
    rawObjectHash: H(o.key),
    version: V,
    ...o,
  } as Swap;
}

export const cov = (
  providerId: "near-bigquery" | "intents-1click" | "coingecko",
  dataset: string,
  d: string,
  state: "complete" | "partial" | "unavailable" = "complete",
  reason: string | null = null,
) => ({ providerId, dataset, day: d, state, reason, sourceLabel: SL, version: V });

export const ALL_DATASETS: Array<["near-bigquery" | "intents-1click" | "coingecko", string]> = [
  ["near-bigquery", "near_daily_usage"],
  ["near-bigquery", "near_signer_days"],
  ["near-bigquery", "contract_interactions"],
  ["intents-1click", "intents_swaps"],
  ["intents-1click", "quote_attempts"],
  ["coingecko", "price_candles"],
];

/** Baseline: 10 days, every source complete. Daily signers 11..20 (overlapping), period unique = 20. */
export function baseline(): NormalizedOutput {
  const t = emptyTables();
  for (let d = 1; d <= 10; d++) {
    const ds = day(d);
    t.near_daily_usage.push({
      blockDate: ds,
      successfulTxCount: String(100 * d),
      functionCallActions: String(150 * d),
      distinctSignerProxy: String(10 + d),
      activeContractCount: String(5 + d),
      sourceLabel: SL,
      rawObjectHash: H(`u${d}`),
      version: V,
    });
    for (let s = 1; s <= 10 + d; s++)
      t.near_signer_days.push({
        blockDate: ds,
        signerAccountId: `s${s}.near`,
        sourceLabel: SL,
        rawObjectHash: H(`sd${d}${s}`),
        version: V,
      });
    t.contract_interactions.push(
      {
        blockDate: ds,
        receiverAccountId: "dex.near",
        project: "dex",
        taxonomy: "defi",
        segmentState: "verified",
        interactions: String(40 * d),
        sourceLabel: SL,
        rawObjectHash: H(`c1${d}`),
        version: V,
      },
      {
        blockDate: ds,
        receiverAccountId: "x.near",
        project: null,
        taxonomy: "uncategorized",
        segmentState: "uncategorized",
        interactions: String(10 * d),
        sourceLabel: SL,
        rawObjectHash: H(`c2${d}`),
        version: V,
      },
    );
    const statuses: Swap["status"][] = ["SUCCESS", "SUCCESS", "FAILED", "REFUNDED", "SUCCESS"];
    for (let i = 0; i < Math.min(d, 5); i++)
      t.intents_swaps.push(
        swap({
          key: `k${d}-${i}`,
          day: ds,
          status: statuses[i]!,
          amountInUsd: `${d + i}.250000000000000000`,
        }),
      );
    for (let a = 1; a <= 4; a++)
      t.quote_attempts.push({
        routeId: "near-usdc",
        originAsset: "NEAR",
        destinationAsset: "USDC",
        amountBaseUnits: "1000000000000000000000000",
        privacyMode: "public",
        scheduledBucketUTC: `${ds}T0${a}:00:00.000Z`,
        attemptNo: 1,
        slot: a === 4 ? "unavailable" : "observed",
        class: a === 4 ? null : a === 3 ? "TIMEOUT" : "OK",
        amountOutBaseUnits: a >= 3 ? null : "5000000",
        fetchedAtUTC: a === 4 ? null : `${ds}T0${a}:00:05.000Z`,
        quoteCostBps: a >= 3 ? null : `${a * 10}.500000000000000000`,
        sourceLabel: SL,
        rawObjectHash: H(`q${d}${a}`),
        version: V,
      });
    t.price_candles.push({
      provider: "coingecko",
      coinId: "near",
      symbol: "near",
      quoteCurrency: "usd",
      interval: "1d",
      bucketStartUTC: `${ds}T00:00:00.000Z`,
      open: "3.1",
      high: "3.5",
      low: "3.0",
      close: `3.${d}25`,
      volume: `${d}000000.500000000000000000`,
      providerTimestampUTC: `${ds}T23:59:59.000Z`,
      fetchedAtUTC: `${ds}T23:59:59.000Z`,
      updateVintage: `${ds}T23:59:59.000Z`,
      sourceLabel: SL,
      rawObjectHash: H(`p${d}`),
      version: V,
    });
    for (const [p, set] of ALL_DATASETS) t.source_coverage.push(cov(p, set, ds));
  }
  t.watermarks.push(
    {
      providerId: "near-bigquery",
      newestEventTime: "2026-10-10T23:59:59.000Z",
      lastFullScanAt: "2026-10-11T00:10:00.000Z",
      gapCount: 0,
      providerLagSeconds: 600,
      schemaVersion: "1",
      state: "fresh",
    },
    {
      providerId: "intents-1click",
      newestEventTime: "2026-10-10T23:59:59.000Z",
      lastFullScanAt: "2026-10-11T00:10:00.000Z",
      gapCount: 0,
      providerLagSeconds: 60,
      schemaVersion: "1",
      state: "fresh",
    },
  );
  return wrap("baseline", t);
}

/** Same raw objects re-delivered plus a status update of swap k3-0 (PENDING_DEPOSIT -> SUCCESS is modelled as SUCCESS -> FAILED here is NOT used; see S10). */
export function duplicatesOf(base: NormalizedOutput, updatedSwapKey: string): NormalizedOutput {
  const t = structuredClone(base.tables);
  const s = t.intents_swaps.find((x) => x.swapKey === updatedSwapKey)!;
  s.status = "FAILED";
  s.version = V + 500;
  t.price_candles = t.price_candles.map((p) => ({ ...p })); // identical re-delivery
  return wrap("duplicates", t);
}

/** zero-vs-gap: 10 days of swaps. Day 3 confirmed zero (complete, no rows), day 6 provider gap, day 9 partial with 2 swaps. */
export function zeroVsGap(): NormalizedOutput {
  const t = emptyTables();
  for (let d = 1; d <= 10; d++) {
    const ds = day(d);
    const state = d === 6 ? "unavailable" : d === 9 ? "partial" : "complete";
    t.source_coverage.push(
      cov(
        "intents-1click",
        "intents_swaps",
        ds,
        state,
        d === 6 ? "PROVIDER_GAP" : d === 9 ? "PARTIAL_SCAN" : null,
      ),
    );
    if (d === 3 || d === 6) continue;
    const n = d === 9 ? 2 : 3;
    for (let i = 0; i < n; i++) t.intents_swaps.push(swap({ key: `z${d}-${i}`, day: ds }));
  }
  t.quality_gaps.push({
    providerId: "intents-1click",
    dataset: "intents_swaps",
    fromUTC: "2026-10-06T00:00:00.000Z",
    toUTC: "2026-10-07T00:00:00.000Z",
    state: "unavailable",
    reasonCode: "PROVIDER_GAP",
    sourceLabel: SL,
  });
  return wrap("zero-vs-gap", t);
}

/** Yocto-scale amounts. Expected sums are computed independently by decimal arithmetic in the test (BigInt), never floats. */
export const DECIMAL_EDGE_AMOUNTS = [
  "340282366920938463463374607431768211455", // 2^128 - 1
  "1",
  "999999999999999999999999",
  "123456789012345678", // 18-decimals token amount
  "9007199254740993", // 2^53 + 1: float64 would round
];
export function decimalEdge(): NormalizedOutput {
  const t = emptyTables();
  DECIMAL_EDGE_AMOUNTS.forEach((a, i) =>
    t.intents_swaps.push(
      swap({ key: `e${i}`, day: day(1), amountIn: a, amountInUsd: `${i}.000000000000000001` }),
    ),
  );
  t.source_coverage.push(cov("intents-1click", "intents_swaps", day(1)));
  return wrap("decimal-edge", t);
}

import type { AssetAlias, SourceWatermark } from "@nearesis/contracts";
import type { StoredSwap } from "./adapters/explorer-parse.ts";
import { normStatus } from "./adapters/explorer-parse.ts";
import { quoteCostBps } from "./adapters/oneclick.ts";
import type { PriceGap } from "./adapters/price.ts";
import type { AssetRegistry } from "./registry/assets.ts";
import type { ContractRegistry } from "./registry/contracts.ts";
import { canonicalJson, sha256Hex } from "./hash.ts";
import type {
  ContractInteractionRow,
  CoverageRow,
  IntentsSwapRow,
  NearDailyUsageRow,
  NearSignerDayRow,
  NormalizedOutput,
  NormalizedTables,
  PriceCandleRow,
  ProviderId,
  QualityGapRow,
  QuoteAttemptRow,
  SourceLabel,
} from "./normalized/types.ts";
import type { AttemptSpec } from "./snapshot.ts";
import type { QuoteClass } from "./adapters/oneclick.ts";

export const PRIVATE_ERA_START = "2026-10-27T00:00:00.000Z";
export const NORMALIZER_VERSION = "normalizer-1.0.0";
const LATE_AFTER_MS = 24 * 3600_000;

export interface ReplayBundle {
  snapshotId: string;
  mode: "replay" | "live";
  nowMs: number;
  explorer?: {
    label: SourceLabel;
    adapterVersion: string;
    swaps: Array<{ stored: StoredSwap; version: number }>;
    days: Array<{
      day: string;
      state: "complete" | "partial" | "unavailable";
      reason: string | null;
      version: number;
    }>;
    gaps: Array<{ fromUTC: string; toUTC: string; state: "unavailable" | "partial"; reasonCode: string }>;
    schemaFingerprint: string | null;
  };
  oneclick?: {
    label: SourceLabel;
    adapterVersion: string;
    attempts: Array<{
      spec: AttemptSpec;
      slot: "observed" | "unavailable";
      cls: QuoteClass | null;
      amountOut: string | null;
      amountOutFormatted: string | null;
      rawHash: string | null;
      version: number;
    }>;
    schemaFingerprint: string | null;
  };
  price?: {
    label: SourceLabel;
    adapterVersion: string;
    rows: PriceCandleRow[];
    gaps: PriceGap[];
    window: { from: string; to: string };
  };
  bigquery?: {
    label: SourceLabel;
    adapterVersion: string;
    dailyUsage: Array<{
      blockDate: string;
      successfulTxCount: string;
      functionCallActions: string;
      distinctSignerProxy: string;
      activeContractCount: string;
      rawHash: string;
      version: number;
    }>;
    signerDays: Array<{ blockDate: string; signerAccountId: string; rawHash: string; version: number }>;
    interactions: Array<{
      blockDate: string;
      receiverAccountId: string;
      interactions: string;
      rawHash: string;
      version: number;
    }>;
  };
  registry?: {
    label: SourceLabel;
    adapterVersion: string;
    aliases: AssetAlias[];
    assets: AssetRegistry | null;
    contracts: ContractRegistry | null;
    rawHash: string;
    version: number;
  };
}

const bySortKey = <T>(rows: T[], key: (r: T) => string): T[] =>
  [...rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

/** sha256 over canonical JSON of the tables (rows sorted by key, object keys sorted). */
export function canonicalDigest(tables: NormalizedTables): string {
  return sha256Hex(canonicalJson(tables));
}

export function privacyFields(
  createdAt: string,
  nearTxHashes: string[],
): Pick<IntentsSwapRow, "privacyEra" | "publicSwapTxHashes" | "boundaryTxHashes" | "reconciliationLevel"> {
  const priv = Date.parse(createdAt) >= Date.parse(PRIVATE_ERA_START);
  if (priv) {
    // D09: from 2026-10-27 nearTxHashes are shield/unshield boundary hashes. The swap hash is never fabricated.
    return {
      privacyEra: "private_settlement",
      publicSwapTxHashes: [],
      boundaryTxHashes: [...nearTxHashes],
      reconciliationLevel: nearTxHashes.length ? "boundary_indicated" : "aggregate_only",
    };
  }
  return {
    privacyEra: "public",
    publicSwapTxHashes: [...nearTxHashes],
    boundaryTxHashes: [],
    reconciliationLevel: nearTxHashes.length ? "exact_public" : "unobservable",
  };
}

const usd = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const day = (iso: string): string => iso.slice(0, 10);

export function normalize(b: ReplayBundle): NormalizedOutput {
  const t: NormalizedTables = {
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
  };
  const adapters: NormalizedOutput["adapters"] = [];
  const assets = b.registry?.assets ?? null;

  if (b.explorer) {
    const e = b.explorer;
    adapters.push({ providerId: "near-explorer", mode: b.mode, adapterVersion: e.adapterVersion });
    for (const { stored, version } of e.swaps) {
      const r = stored.record;
      const priv = privacyFields(r.createdAt, r.nearTxHashes);
      const status = normStatus(r.status) as IntentsSwapRow["status"];
      const resolve = (id: string): string | null => {
        const x = assets?.resolve("intents-1click", id, r.createdAt);
        return x && x.status === "found" && x.verification === "verified" ? x.canonicalAssetId : null;
      };
      t.intents_swaps.push({
        sourceLabel: e.label,
        rawObjectHash: stored.rawObjectHash,
        version,
        swapKey: stored.swapKey,
        depositAddress: r.depositAddress,
        depositMemo: r.depositMemo,
        status,
        createdAtUTC: new Date(r.createdAt).toISOString(),
        createdDay: day(new Date(r.createdAt).toISOString()),
        originAsset: r.originAsset,
        destinationAsset: r.destinationAsset,
        canonicalOriginAsset: resolve(r.originAsset),
        canonicalDestinationAsset: resolve(r.destinationAsset),
        amountIn: r.amountIn,
        amountOut: r.amountOut,
        amountFinal: status === "SUCCESS" || status === "FAILED" || status === "REFUNDED",
        amountInUsd: usd(r.amountInUsd),
        amountOutUsd: usd(r.amountOutUsd),
        depositType: r.depositType,
        recipientType: r.recipientType,
        referral: r.referral ?? null,
        ...priv,
      });
    }
    for (const d of e.days) {
      t.source_coverage.push({
        providerId: "near-explorer",
        dataset: "intents_swaps",
        day: d.day,
        state: d.state,
        reason: d.reason,
        sourceLabel: e.label,
        version: d.version,
      });
    }
    for (const g of e.gaps)
      t.quality_gaps.push({
        providerId: "near-explorer",
        dataset: "intents_swaps",
        ...g,
        sourceLabel: e.label,
      });
    const newest =
      e.swaps
        .map((s) => new Date(s.stored.record.createdAt).toISOString())
        .sort()
        .at(-1) ?? null;
    t.watermarks.push(watermark("near-explorer", newest, e.gaps.length, e.schemaFingerprint, b.nowMs));
  }

  if (b.oneclick) {
    const o = b.oneclick;
    adapters.push({ providerId: "intents-1click", mode: b.mode, adapterVersion: o.adapterVersion });
    for (const a of o.attempts) {
      const s = a.spec;
      const bench = s.benchmarkOutFormatted;
      t.quote_attempts.push({
        sourceLabel: o.label,
        rawObjectHash: a.rawHash ?? "",
        version: a.version,
        routeId: s.routeId,
        originAsset: s.originAsset,
        destinationAsset: s.destinationAsset,
        amountBaseUnits: s.amountBaseUnits,
        privacyMode: s.privacyMode,
        scheduledBucketUTC: s.scheduledBucketUTC,
        attemptNo: s.attemptNo,
        slot: a.slot,
        class: a.cls,
        amountOutBaseUnits: a.amountOut,
        fetchedAtUTC: a.slot === "observed" ? s.fetchedAtUTC : null,
        quoteCostBps:
          a.cls === "OK" && bench && a.amountOutFormatted ? quoteCostBps(a.amountOutFormatted, bench) : null,
      } satisfies QuoteAttemptRow);
    }
    const newest =
      o.attempts
        .filter((a) => a.slot === "observed")
        .map((a) => a.spec.fetchedAtUTC)
        .sort()
        .at(-1) ?? null;
    t.watermarks.push(
      watermark(
        "intents-1click",
        newest,
        o.attempts.filter((a) => a.slot === "unavailable").length,
        o.schemaFingerprint,
        b.nowMs,
      ),
    );
  }

  if (b.price) {
    const p = b.price;
    adapters.push({ providerId: "coingecko", mode: b.mode, adapterVersion: p.adapterVersion });
    t.price_candles.push(...p.rows);
    const have = new Set(p.rows.map((r) => r.bucketStartUTC.slice(0, 10)));
    const days: string[] = [];
    for (
      let ms = Date.parse(`${p.window.from}T00:00:00Z`);
      ms <= Date.parse(`${p.window.to}T00:00:00Z`);
      ms += 86_400_000
    )
      days.push(new Date(ms).toISOString().slice(0, 10));
    const v = Math.max(0, ...p.rows.map((r) => r.version));
    for (const d of days) {
      t.source_coverage.push({
        providerId: "coingecko",
        dataset: "price_candles",
        day: d,
        state: have.has(d) ? "complete" : "unavailable",
        reason: have.has(d) ? null : "PROVIDER_GAP",
        sourceLabel: p.label,
        version: v,
      });
    }
    for (const g of p.gaps)
      t.quality_gaps.push({
        providerId: "coingecko",
        dataset: "price_candles",
        fromUTC: `${g.day}T00:00:00.000Z`,
        toUTC: `${g.day}T23:59:59.999Z`,
        state: "unavailable",
        reasonCode: g.reason,
        sourceLabel: p.label,
      });
    const newest =
      p.rows
        .map((r) => r.providerTimestampUTC)
        .sort()
        .at(-1) ?? null;
    t.watermarks.push(watermark("coingecko", newest, p.gaps.length, "ohlc-5", b.nowMs));
  }

  if (b.bigquery) {
    const q = b.bigquery;
    adapters.push({ providerId: "near-bigquery", mode: b.mode, adapterVersion: q.adapterVersion });
    for (const r of q.dailyUsage) {
      t.near_daily_usage.push({
        sourceLabel: q.label,
        rawObjectHash: r.rawHash,
        version: r.version,
        blockDate: r.blockDate,
        successfulTxCount: r.successfulTxCount,
        functionCallActions: r.functionCallActions,
        distinctSignerProxy: r.distinctSignerProxy,
        activeContractCount: r.activeContractCount,
      } satisfies NearDailyUsageRow);
      t.source_coverage.push({
        providerId: "near-bigquery",
        dataset: "near_daily_usage",
        day: r.blockDate,
        state: "complete",
        reason: null,
        sourceLabel: q.label,
        version: r.version,
      });
    }
    for (const r of q.signerDays)
      t.near_signer_days.push({
        sourceLabel: q.label,
        rawObjectHash: r.rawHash,
        version: r.version,
        blockDate: r.blockDate,
        signerAccountId: r.signerAccountId,
      } satisfies NearSignerDayRow);
    for (const r of q.interactions) {
      const seg = b.registry?.contracts?.assign("near", r.receiverAccountId, `${r.blockDate}T00:00:00Z`) ?? {
        project: null,
        taxonomy: "uncategorized",
        segmentState: "uncategorized" as const,
      };
      t.contract_interactions.push({
        sourceLabel: q.label,
        rawObjectHash: r.rawHash,
        version: r.version,
        blockDate: r.blockDate,
        receiverAccountId: r.receiverAccountId,
        project: seg.project,
        taxonomy: seg.taxonomy,
        segmentState: seg.segmentState,
        interactions: r.interactions,
      } satisfies ContractInteractionRow);
    }
    const newest =
      q.dailyUsage
        .map((r) => `${r.blockDate}T00:00:00.000Z`)
        .sort()
        .at(-1) ?? null;
    t.watermarks.push(watermark("near-bigquery", newest, 0, "bq-1", b.nowMs));
  }

  if (b.registry) {
    const r = b.registry;
    adapters.push({ providerId: "near-contract-registry", mode: b.mode, adapterVersion: r.adapterVersion });
    t.asset_aliases.push(...r.aliases);
    if (r.contracts) {
      t.contract_registry.push(...r.contracts.rows.map((x) => ({ ...x })));
      for (const c of r.contracts.conflicts)
        t.quality_gaps.push({
          providerId: "near-contract-registry",
          dataset: "contract_registry",
          fromUTC: c.rows.map((x) => x.validFrom).sort()[0] as string,
          toUTC: c.rows
            .map((x) => x.validTo ?? "9999-12-31T00:00:00.000Z")
            .sort()
            .at(-1) as string,
          state: "partial",
          reasonCode: "REGISTRY_CONFLICT",
          sourceLabel: r.label,
        });
    }
    t.watermarks.push({
      providerId: "near-contract-registry",
      newestEventTime: null,
      lastFullScanAt: new Date(b.nowMs).toISOString(),
      gapCount: r.contracts?.conflicts.length ?? 0,
      providerLagSeconds: null,
      schemaVersion: "registry-1",
      state: "fresh",
    });
  }

  const sorted: NormalizedTables = {
    intents_swaps: bySortKey(t.intents_swaps, (r) => r.swapKey),
    quote_attempts: bySortKey(t.quote_attempts, (r) =>
      [
        r.routeId,
        r.amountBaseUnits.padStart(60, "0"),
        r.privacyMode,
        r.scheduledBucketUTC,
        String(r.attemptNo).padStart(6, "0"),
      ].join("|"),
    ),
    price_candles: bySortKey(t.price_candles, (r) =>
      [r.provider, r.coinId, r.quoteCurrency, r.interval, r.bucketStartUTC, r.updateVintage].join("|"),
    ),
    near_daily_usage: bySortKey(t.near_daily_usage, (r) => r.blockDate),
    near_signer_days: bySortKey(t.near_signer_days, (r) => `${r.blockDate}|${r.signerAccountId}`),
    contract_interactions: bySortKey(t.contract_interactions, (r) => `${r.blockDate}|${r.receiverAccountId}`),
    source_coverage: bySortKey(t.source_coverage, (r) => `${r.providerId}|${r.dataset}|${r.day}`),
    quality_gaps: bySortKey(
      t.quality_gaps,
      (r) => `${r.providerId}|${r.dataset}|${r.fromUTC}|${r.toUTC}|${r.reasonCode}`,
    ),
    asset_aliases: bySortKey(t.asset_aliases, (r) => `${r.providerId}|${r.providerAssetId}|${r.validFrom}`),
    contract_registry: bySortKey(
      t.contract_registry,
      (r) => `${r.chain}|${r.accountId}|${r.validFrom}|${r.project}`,
    ),
    watermarks: bySortKey(t.watermarks, (r) => r.providerId),
  };
  return {
    snapshotId: b.snapshotId,
    mode: b.mode,
    adapters: bySortKey(adapters, (a) => a.providerId),
    tables: sorted,
    digest: canonicalDigest(sorted),
  };
}

function watermark(
  providerId: ProviderId,
  newest: string | null,
  gapCount: number,
  schemaVersion: string | null,
  nowMs: number,
): SourceWatermark {
  const lag = newest ? Math.max(0, nowMs - Date.parse(newest)) : null;
  const state: SourceWatermark["state"] =
    newest === null
      ? "unavailable"
      : gapCount > 0
        ? "partial"
        : lag !== null && lag > LATE_AFTER_MS
          ? "late"
          : "fresh";
  return {
    providerId,
    newestEventTime: newest,
    lastFullScanAt: gapCount === 0 && newest !== null ? new Date(nowMs).toISOString() : null,
    gapCount,
    providerLagSeconds: lag === null ? null : lag / 1000,
    schemaVersion,
    state,
  };
}

export type { CoverageRow, QualityGapRow };

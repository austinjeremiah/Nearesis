/**
 * Ingestion → analytics boundary (owner: Engine B lead; frozen for B1/B2 on 2026-11-10).
 *
 * services/ingestion (B1) produces a deterministic `NormalizedOutput` from raw observations.
 * services/analytics (B2) loads it into ClickHouse (ReplacingMergeTree keyed by the `key` fields below,
 * version column `version`). Changing a field here needs the lead's approval; add fields only.
 *
 * Rules (ch.07, D05, D09, D11, S11, S15):
 * - Exact amounts are decimal strings. Never JS numbers for smallest-unit amounts or prices.
 * - Missing data is a `CoverageRow` with state `unavailable` / a `QualityGapRow`, never a zero row.
 * - Every row carries `sourceLabel` and the `rawObjectHash` it came from (provenance).
 */
import type {
  AssetAlias,
  ContractRegistryEntry,
  QuoteAttemptClass,
  SourceWatermark,
} from "@nearesis/contracts";

export type SourceLabel = "SYNTHETIC" | "RECORDED" | "LIVE";
export type ProviderId =
  "near-bigquery" | "near-explorer" | "intents-1click" | "coingecko" | "near-contract-registry";

interface Provenance {
  sourceLabel: SourceLabel;
  rawObjectHash: string; // sha256 hex of the archived payload
  /** Monotonic version for ReplacingMergeTree (fetchedAt epoch ms of the observation; later wins). */
  version: number;
}

/** Explorer 1Click swap. key = swapKey. */
export interface IntentsSwapRow extends Provenance {
  swapKey: string; // `${depositAddress}|${depositMemo ?? ""}`
  depositAddress: string;
  depositMemo: string | null;
  status:
    "SUCCESS" | "FAILED" | "INCOMPLETE_DEPOSIT" | "PENDING_DEPOSIT" | "PROCESSING" | "REFUNDED" | "UNKNOWN";
  createdAtUTC: string; // ISO
  createdDay: string; // YYYY-MM-DD UTC
  originAsset: string; // provider asset id as observed
  destinationAsset: string;
  canonicalOriginAsset: string | null; // via effective-dated AssetAlias (D08); null = unresolved
  canonicalDestinationAsset: string | null;
  amountIn: string | null; // smallest unit, exact; null = provider reported empty string (unknown, never 0)
  amountOut: string | null;
  amountFinal: boolean; // false for non-final statuses where provider reports 0
  amountInUsd: string | null; // decimal string
  amountOutUsd: string | null;
  depositType: string;
  recipientType: string;
  referral: string | null;
  privacyEra: "public" | "private_settlement"; // createdAt >= 2026-10-27T00:00:00Z => private_settlement
  /** D09: in private era, nearTxHashes are shield/unshield hashes, never the swap hash. */
  publicSwapTxHashes: string[]; // empty in private era
  boundaryTxHashes: string[]; // shield/unshield hashes (private era only)
  reconciliationLevel: "exact_public" | "boundary_indicated" | "aggregate_only" | "unobservable";
}

/** 1Click dry quote attempt (D07). key = (routeId, amountBaseUnits, privacyMode, scheduledBucketUTC, attemptNo). */
export interface QuoteAttemptRow extends Provenance {
  routeId: string;
  originAsset: string;
  destinationAsset: string;
  amountBaseUnits: string;
  privacyMode: "public" | "basic" | "advanced";
  scheduledBucketUTC: string;
  attemptNo: number;
  slot: "observed" | "unavailable"; // missed grid slot => unavailable, never backfilled
  class: QuoteAttemptClass | null; // null only when slot = unavailable
  amountOutBaseUnits: string | null;
  fetchedAtUTC: string | null;
  quoteCostBps: string | null; // decimal string vs declared benchmark, null if not computable
}

/** Daily candle (D13). key = (provider, coinId, quoteCurrency, interval, bucketStartUTC, updateVintage). */
export interface PriceCandleRow extends Provenance {
  provider: "coingecko";
  coinId: string;
  symbol: string;
  quoteCurrency: string;
  interval: "1d";
  bucketStartUTC: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  providerTimestampUTC: string;
  fetchedAtUTC: string;
  updateVintage: string; // ISO; multiple vintages kept
}

/** BigQuery daily usage (signer proxy, never "users"). key = blockDate. */
export interface NearDailyUsageRow extends Provenance {
  blockDate: string;
  successfulTxCount: string; // integer string
  functionCallActions: string;
  distinctSignerProxy: string; // daily distinct signers; NOT summable across days (S02)
  activeContractCount: string;
}

/** Underlying signer-day pairs so period uniques are computed by distinct, not by summing days (S02). key = (blockDate, signerAccountId). */
export interface NearSignerDayRow extends Provenance {
  blockDate: string;
  signerAccountId: string;
}

/** Contract interactions by registry segment (D17). key = (blockDate, receiverAccountId). */
export interface ContractInteractionRow extends Provenance {
  blockDate: string;
  receiverAccountId: string;
  project: string | null; // null unless mapping verified
  taxonomy: string; // "uncategorized" | "unverified" | named taxonomy (verified only)
  segmentState: "verified" | "unverified" | "ambiguous" | "uncategorized";
  interactions: string;
}

/** Per-source per-day coverage (S11 zero vs gap vs partial). key = (providerId, dataset, day). */
export interface CoverageRow {
  providerId: ProviderId;
  dataset: string; // e.g. "intents_swaps", "price_candles"
  day: string;
  state: "complete" | "partial" | "unavailable";
  reason: string | null;
  sourceLabel: SourceLabel;
  version: number;
}

export interface QualityGapRow {
  providerId: ProviderId;
  dataset: string;
  fromUTC: string;
  toUTC: string;
  state: "unavailable" | "partial";
  reasonCode: string; // e.g. PROVIDER_GAP, AUTH_REJECTED, QUARANTINED_BODY
  sourceLabel: SourceLabel;
}

export interface ContractRegistryRow extends ContractRegistryEntry {
  rowState: "active" | "quarantined";
  conflictGroup: string | null;
}

export interface NormalizedTables {
  intents_swaps: IntentsSwapRow[];
  quote_attempts: QuoteAttemptRow[];
  price_candles: PriceCandleRow[];
  near_daily_usage: NearDailyUsageRow[];
  near_signer_days: NearSignerDayRow[];
  contract_interactions: ContractInteractionRow[];
  source_coverage: CoverageRow[];
  quality_gaps: QualityGapRow[];
  asset_aliases: AssetAlias[];
  contract_registry: ContractRegistryRow[];
  watermarks: SourceWatermark[];
}

export interface NormalizedOutput {
  snapshotId: string;
  mode: "replay" | "live";
  adapters: Array<{ providerId: ProviderId; mode: "replay" | "live"; adapterVersion: string }>;
  tables: NormalizedTables;
  /** sha256 hex over canonical JSON of `tables` (rows sorted by key, keys sorted). */
  digest: string;
}

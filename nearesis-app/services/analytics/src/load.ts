import type { ClickHouseClient } from "@clickhouse/client";
import type { NormalizedOutput } from "../../ingestion/src/normalized/types.ts";

type Row = Record<string, unknown>;
const day = (iso: string) => iso.slice(0, 10);
const dec = (s: string | null | undefined) => (s === null || s === undefined ? null : s);
const t = (s: string | null | undefined) => (s === null || s === undefined ? null : s);

export const FACT_TABLES = [
  "intents_swaps",
  "quote_attempts",
  "price_candles",
  "near_daily_usage",
  "near_signer_days",
  "contract_interactions",
  "economics_reports",
  "agent_market_jobs",
  "source_coverage",
  "quality_gaps",
  "source_watermarks",
  "asset_aliases",
  "contract_registry",
] as const;
export type FactTable = (typeof FACT_TABLES)[number];

/** Pure mapping NormalizedOutput -> column rows per ClickHouse table. Amount strings pass through untouched (S15). */
export function toRows(output: NormalizedOutput): Record<string, Row[]> {
  const T = output.tables;
  const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 1);
  return {
    intents_swaps: T.intents_swaps.map((r) => ({
      swap_key: r.swapKey,
      deposit_address: r.depositAddress,
      deposit_memo: r.depositMemo,
      status: r.status,
      created_at: r.createdAtUTC,
      created_day: r.createdDay,
      origin_asset: r.originAsset,
      destination_asset: r.destinationAsset,
      canonical_origin_asset: r.canonicalOriginAsset,
      canonical_destination_asset: r.canonicalDestinationAsset,
      amount_in_raw: r.amountIn,
      amount_out_raw: r.amountOut,
      amount_in: r.amountIn,
      amount_out: r.amountOut,
      amount_final: r.amountFinal ? 1 : 0,
      amount_in_usd_raw: dec(r.amountInUsd),
      amount_out_usd_raw: dec(r.amountOutUsd),
      amount_in_usd: dec(r.amountInUsd),
      amount_out_usd: dec(r.amountOutUsd),
      deposit_type: r.depositType,
      recipient_type: r.recipientType,
      referral: r.referral,
      privacy_era: r.privacyEra,
      public_swap_tx_hashes: r.publicSwapTxHashes,
      boundary_tx_hashes: r.boundaryTxHashes,
      reconciliation_level: r.reconciliationLevel,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    quote_attempts: T.quote_attempts.map((r) => ({
      route_id: r.routeId,
      origin_asset: r.originAsset,
      destination_asset: r.destinationAsset,
      amount_base_units_raw: r.amountBaseUnits,
      amount_base_units: r.amountBaseUnits,
      privacy_mode: r.privacyMode,
      scheduled_bucket: r.scheduledBucketUTC,
      day: day(r.scheduledBucketUTC),
      attempt_no: r.attemptNo,
      slot: r.slot,
      attempt_class: r.class,
      amount_out_raw: r.amountOutBaseUnits,
      amount_out: r.amountOutBaseUnits,
      fetched_at: t(r.fetchedAtUTC),
      quote_cost_bps_raw: r.quoteCostBps,
      quote_cost_bps: r.quoteCostBps,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    price_candles: T.price_candles.map((r) => ({
      provider: r.provider,
      coin_id: r.coinId,
      symbol: r.symbol,
      quote_currency: r.quoteCurrency,
      interval: r.interval,
      bucket_start: r.bucketStartUTC,
      day: day(r.bucketStartUTC),
      open_raw: r.open,
      high_raw: r.high,
      low_raw: r.low,
      close_raw: r.close,
      volume_raw: r.volume,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      provider_timestamp: r.providerTimestampUTC,
      fetched_at: r.fetchedAtUTC,
      update_vintage: r.updateVintage,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    near_daily_usage: T.near_daily_usage.map((r) => ({
      block_date: r.blockDate,
      successful_tx_count: r.successfulTxCount,
      function_call_actions: r.functionCallActions,
      distinct_signer_proxy: r.distinctSignerProxy,
      active_contract_count: r.activeContractCount,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    near_signer_days: T.near_signer_days.map((r) => ({
      block_date: r.blockDate,
      signer_account_id: r.signerAccountId,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    contract_interactions: T.contract_interactions.map((r) => ({
      block_date: r.blockDate,
      receiver_account_id: r.receiverAccountId,
      project: r.project,
      taxonomy: r.taxonomy,
      segment_state: r.segmentState,
      interactions: r.interactions,
      source_label: r.sourceLabel,
      raw_object_hash: r.rawObjectHash,
      version: r.version,
    })),
    source_coverage: T.source_coverage.map((r) => ({
      provider_id: r.providerId,
      dataset: r.dataset,
      day: r.day,
      state: r.state,
      reason: r.reason,
      source_label: r.sourceLabel,
      version: r.version,
    })),
    quality_gaps: T.quality_gaps.map((r) => ({
      provider_id: r.providerId,
      dataset: r.dataset,
      from_utc: r.fromUTC,
      to_utc: r.toUTC,
      state: r.state,
      reason_code: r.reasonCode,
      source_label: r.sourceLabel,
      version: 1,
    })),
    source_watermarks: T.watermarks.map((r) => ({
      provider_id: r.providerId,
      newest_event_time: r.newestEventTime,
      last_full_scan_at: r.lastFullScanAt,
      gap_count: r.gapCount,
      provider_lag_seconds: r.providerLagSeconds,
      schema_version: r.schemaVersion,
      state: r.state,
      version: ms(r.lastFullScanAt ?? r.newestEventTime),
    })),
    asset_aliases: T.asset_aliases.map((r) => ({
      canonical_asset_id: r.canonicalAssetId,
      provider_asset_id: r.providerAssetId,
      provider_id: r.providerId,
      valid_from: r.validFrom,
      valid_to: r.validTo,
      evidence_url: r.evidenceUrl,
      verification: r.verification,
      version: 1,
    })),
    contract_registry: T.contract_registry.map((r) => ({
      chain: r.chain,
      account_id: r.accountId,
      project: r.project,
      taxonomy: r.taxonomy,
      valid_from: r.validFrom,
      valid_to: r.validTo,
      ownership_verification: r.ownershipVerification,
      evidence_url: r.evidenceUrl,
      ambiguity_score: r.ambiguityScore,
      row_state: r.rowState,
      conflict_group: r.conflictGroup,
      version: 1,
    })),
  };
}

/** Idempotent load: re-delivery of the same natural key with an equal/lower version never changes a FINAL read. */
export async function loadNormalized(
  ch: ClickHouseClient,
  output: NormalizedOutput,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [table, values] of Object.entries(toRows(output))) {
    counts[table] = values.length;
    if (!values.length) continue;
    await ch.insert({
      table,
      values,
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
    });
  }
  return counts;
}

/** Supplementary analytics-owned facts (economics / agent market reports). */
export async function loadSupplementary(
  ch: ClickHouseClient,
  s: {
    economics?: Array<{
      day: string;
      source: string;
      revenueUsd: string;
      sourceLabel: string;
      version: number;
    }>;
    agentMarket?: Array<{
      day: string;
      market: string;
      completedJobs: string;
      isPublic: boolean;
      sourceLabel: string;
      version: number;
    }>;
  },
): Promise<void> {
  if (s.economics?.length)
    await ch.insert({
      table: "economics_reports",
      format: "JSONEachRow",
      values: s.economics.map((e) => ({
        report_day: e.day,
        report_source: e.source,
        revenue_usd_raw: e.revenueUsd,
        revenue_usd: e.revenueUsd,
        source_label: e.sourceLabel,
        version: e.version,
      })),
    });
  if (s.agentMarket?.length)
    await ch.insert({
      table: "agent_market_jobs",
      format: "JSONEachRow",
      values: s.agentMarket.map((e) => ({
        job_day: e.day,
        market: e.market,
        completed_jobs: e.completedJobs,
        is_public: e.isPublic ? 1 : 0,
        source_label: e.sourceLabel,
        version: e.version,
      })),
    });
}

/** Test/fixture reset: empties every analytics table (never touches schema_migrations). */
export async function truncateAll(ch: ClickHouseClient): Promise<void> {
  for (const t of FACT_TABLES) await ch.command({ query: `TRUNCATE TABLE IF EXISTS ${t}` });
}

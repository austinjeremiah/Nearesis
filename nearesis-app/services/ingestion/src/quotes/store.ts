import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { buildQuoteIntel, type QuoteAttemptFacts, type QuoteIntel } from "./intel.ts";

/** Additive sidecar of quote_attempts: one derived row per attempt. quote_attempts itself is not altered. */
export const QUOTE_INTEL_DDL = `CREATE TABLE IF NOT EXISTS quote_intel
(
  route_id String,
  origin_asset String,
  destination_asset String,
  amount_base_units String,
  privacy_mode LowCardinality(String),
  scheduled_bucket_utc DateTime64(3, 'UTC'),
  attempt_no UInt16,
  availability LowCardinality(String),
  error_category LowCardinality(String),
  http_status Nullable(UInt16),
  rate_limit_status LowCardinality(String),
  rate_limit_remaining Nullable(Int64),
  input_amount_base_units String,
  input_amount_formatted Nullable(String),
  input_amount_usd Nullable(Decimal256(18)),
  estimated_output_base_units Nullable(String),
  estimated_output_formatted Nullable(String),
  estimated_output_usd Nullable(Decimal256(18)),
  quoted_effective_rate Nullable(Decimal256(18)),
  usd_implied_cost_bps Nullable(Decimal256(4)),
  time_estimate_s Nullable(Float64),
  latency_ms Nullable(UInt32),
  quote_timestamp Nullable(DateTime64(3, 'UTC')),
  fetched_at Nullable(DateTime64(3, 'UTC')),
  provider_version LowCardinality(String),
  adapter_version LowCardinality(Nullable(String)),
  quote_kind LowCardinality(String),
  signature_present UInt8,
  signature_status LowCardinality(String),
  signature_reason String,
  raw_object_hash Nullable(String),
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(scheduled_bucket_utc)
ORDER BY (route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no)`;

export const intelRow = (i: QuoteIntel, version: number): Record<string, unknown> => ({
  route_id: i.routeId,
  origin_asset: i.originAsset,
  destination_asset: i.destinationAsset,
  amount_base_units: i.amountBaseUnits,
  privacy_mode: i.privacyMode,
  scheduled_bucket_utc: i.scheduledBucketUtc,
  attempt_no: i.attemptNo,
  availability: i.availability,
  error_category: i.errorCategory,
  http_status: i.httpStatus,
  rate_limit_status: i.rateLimitStatus,
  rate_limit_remaining: i.rateLimitRemaining,
  input_amount_base_units: i.inputAmountBaseUnits,
  input_amount_formatted: i.inputAmountFormatted,
  input_amount_usd: i.inputAmountUsd,
  estimated_output_base_units: i.estimatedOutputBaseUnits,
  estimated_output_formatted: i.estimatedOutputFormatted,
  estimated_output_usd: i.estimatedOutputUsd,
  quoted_effective_rate: i.quotedEffectiveRate,
  usd_implied_cost_bps: i.usdImpliedCostBps,
  time_estimate_s: i.timeEstimateS,
  latency_ms: i.latencyMs,
  quote_timestamp: i.quoteTimestamp,
  fetched_at: i.fetchedAt,
  provider_version: i.providerVersion,
  adapter_version: i.adapterVersion,
  quote_kind: i.quoteKind,
  signature_present: i.signaturePresent ? 1 : 0,
  signature_status: i.signatureStatus,
  signature_reason: i.signatureReason,
  raw_object_hash: i.rawObjectHash,
  version,
});

export type PayloadReader = (hash: string) => Promise<Uint8Array | null>;

/** Content-addressed object store layout used by the scheduler: <dir>/<first two hex>/<hash>. */
export const fileObjectReader =
  (dir: string): PayloadReader =>
  async (hash) => {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    try {
      return await readFile(join(dir, hash.slice(0, 2), hash));
    } catch {
      return null;
    }
  };

export async function ensureQuoteIntelTable(ch: ClickHouseClient): Promise<void> {
  await ch.command({ query: QUOTE_INTEL_DDL });
}

interface AttemptRow {
  route_id: string;
  origin_asset: string;
  destination_asset: string;
  amount_base_units: string;
  privacy_mode: string;
  scheduled_bucket_utc: string;
  attempt_no: number;
  slot: "observed" | "unavailable";
  class: QuoteAttemptFacts["class"];
  reason: string | null;
  http_status: number | null;
  latency_ms: number | null;
  fetched_at: string | null;
  raw_object_hash: string | null;
}

/**
 * Derives intelligence for every quote_attempts row that has none yet (idempotent, read-only on the source rows, no network).
 * Rows whose raw payload is no longer on disk still get a record, with payload-derived fields null.
 */
export async function backfillQuoteIntel(
  ch: ClickHouseClient,
  read: PayloadReader,
  opts: { batch?: number; maxRows?: number; now?: () => number } = {},
): Promise<{ written: number; missingPayload: number; signature: Record<string, number> }> {
  const batch = opts.batch ?? 500;
  const now = opts.now ?? Date.now;
  let written = 0;
  let missingPayload = 0;
  const signature: Record<string, number> = {};
  for (;;) {
    if (opts.maxRows !== undefined && written >= opts.maxRows) break;
    const rs = await ch.query({
      query: `SELECT route_id, origin_asset, destination_asset, amount_base_units, privacy_mode, toString(scheduled_bucket_utc) AS scheduled_bucket_utc,
                     attempt_no, slot, class, reason, http_status, latency_ms, toString(fetched_at) AS fetched_at, raw_object_hash
              FROM quote_attempts FINAL
              WHERE (route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no) NOT IN
                    (SELECT route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no FROM quote_intel FINAL)
              ORDER BY scheduled_bucket_utc LIMIT {n:UInt32}`,
      query_params: { n: batch },
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as AttemptRow[];
    if (rows.length === 0) break;
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const payload = r.raw_object_hash ? await read(r.raw_object_hash) : null;
      if (r.raw_object_hash && !payload) missingPayload++;
      const intel = buildQuoteIntel(
        {
          routeId: r.route_id,
          originAsset: r.origin_asset,
          destinationAsset: r.destination_asset,
          amountBaseUnits: r.amount_base_units,
          privacyMode: r.privacy_mode,
          scheduledBucketUtc: r.scheduled_bucket_utc,
          attemptNo: r.attempt_no,
          slot: r.slot,
          class: r.class,
          reason: r.reason,
          httpStatus: r.http_status,
          latencyMs: r.latency_ms,
          fetchedAt: r.fetched_at,
          rawObjectHash: r.raw_object_hash,
        },
        payload,
      );
      signature[intel.signatureStatus] = (signature[intel.signatureStatus] ?? 0) + 1;
      out.push(intelRow(intel, now()));
    }
    await ch.insert({ table: "quote_intel", values: out, format: "JSONEachRow" });
    written += out.length;
  }
  return { written, missingPayload, signature };
}

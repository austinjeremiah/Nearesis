import type { Db } from "./db.ts";
import { EXPLORER_ADAPTER_VERSION } from "./adapters/explorer.ts";
import type { ExplorerTx } from "./adapters/explorer-parse.ts";
import type { ReplayBundle } from "./normalize.ts";
import type { SourceLabel } from "./normalized/types.ts";

/** Builds the explorer part of a normalizer input from the Postgres import state (live collector output). */
export async function explorerBundleFromDb(
  db: Db,
  label: SourceLabel,
  nowMs: number,
  snapshotId = "live",
): Promise<ReplayBundle> {
  const sw = await db.query<{
    swap_key: string;
    status: string;
    created_at: Date;
    amount_in: string;
    amount_out: string;
    raw_object_hash: string;
    version_ms: string;
    record: ExplorerTx;
  }>(
    "SELECT swap_key, status, created_at, amount_in, amount_out, raw_object_hash, version_ms, record FROM ingestion.explorer_swaps ORDER BY swap_key",
  );
  const cov = await db.query<{
    day: string;
    state: "complete" | "partial" | "unavailable";
    reason: string | null;
  }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, state, reason FROM ingestion.source_coverage WHERE provider_id='near-explorer' ORDER BY day",
  );
  const gaps = await db.query<{
    from_utc: Date;
    to_utc: Date;
    state: "unavailable" | "partial";
    reason_code: string;
  }>(
    "SELECT from_utc, to_utc, state, reason_code FROM ingestion.quality_gaps WHERE provider_id='near-explorer' ORDER BY id",
  );
  return {
    snapshotId,
    mode: "live",
    nowMs,
    explorer: {
      label,
      adapterVersion: EXPLORER_ADAPTER_VERSION,
      schemaFingerprint: null,
      swaps: sw.rows.map((r) => ({
        version: Number(r.version_ms),
        stored: {
          swapKey: r.swap_key,
          status: r.status,
          createdAt: r.created_at.toISOString(),
          amountIn: r.amount_in,
          amountOut: r.amount_out,
          rawObjectHash: r.raw_object_hash,
          record: r.record,
        },
      })),
      days: cov.rows.map((r) => ({ day: r.day, state: r.state, reason: r.reason, version: nowMs })),
      gaps: gaps.rows.map((r) => ({
        fromUTC: r.from_utc.toISOString(),
        toUTC: r.to_utc.toISOString(),
        state: r.state,
        reasonCode: r.reason_code,
      })),
    },
  };
}

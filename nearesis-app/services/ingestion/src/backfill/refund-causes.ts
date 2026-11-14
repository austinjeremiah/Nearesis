import type { ClickHouseClient } from "@clickhouse/client";
import type { Db } from "../db.ts";
import type { ExplorerTx } from "../adapters/explorer-parse.ts";
import { insertLive, type Row } from "./ch.ts";

/** The slice of an imported Explorer swap the refund side table needs. */
export interface RefundSource {
  swap_key: string;
  status: string;
  created_at: Date;
  raw_object_hash: string;
  version_ms: string | number;
  record: ExplorerTx;
}

/** A swap gets a refund row when it is REFUNDED or FAILED or carries a refundReason; others have nothing to say. */
export const hasRefundInfo = (s: Pick<RefundSource, "status" | "record">): boolean =>
  s.status === "REFUNDED" || s.status === "FAILED" || (s.record.refundReason ?? null) !== null;

export function refundRows(rows: RefundSource[], fetchedAtUTC: string): Row[] {
  return rows.filter(hasRefundInfo).map((s) => {
    const created = s.created_at.toISOString();
    return {
      swap_key: s.swap_key,
      status: s.status,
      created_at: created,
      created_day: created.slice(0, 10),
      refund_reason: s.record.refundReason ?? null,
      refund_to: s.record.refundTo ?? null,
      refund_fee_raw: s.record.refundFee ?? null,
      refund_fee_formatted: s.record.refundFeeFormatted ?? null,
      refund_type: s.record.refundType,
      source_label: "LIVE",
      raw_object_hash: s.raw_object_hash,
      fetched_at: fetchedAtUTC,
      version: Number(s.version_ms),
    };
  });
}

/**
 * Fills `intents_swap_refunds` from the imported swaps (Postgres `ingestion.explorer_swaps`, a verbatim copy of the raw
 * archive pages), keyset-paged and idempotent (ReplacingMergeTree by swap_key + version). No network.
 * The normal load path (`loadSwapsToClickHouse`) writes the same rows going forward.
 */
export async function loadRefundCauses(db: Db, ch: ClickHouseClient, nowMs: number): Promise<number> {
  let afterV = 0;
  let afterK = "";
  let written = 0;
  for (;;) {
    const r = await db.query<RefundSource>(
      `SELECT swap_key, status, created_at, raw_object_hash, version_ms, record
         FROM ingestion.explorer_swaps
        WHERE (version_ms, swap_key) > ($1::bigint, $2::text)
          AND (status IN ('REFUNDED','FAILED') OR record->>'refundReason' IS NOT NULL)
        ORDER BY version_ms, swap_key LIMIT 5000`,
      [afterV, afterK],
    );
    if (r.rows.length === 0) break;
    written += await insertLive(ch, "intents_swap_refunds", refundRows(r.rows, new Date(nowMs).toISOString()));
    const last = r.rows[r.rows.length - 1]!;
    afterV = Number(last.version_ms);
    afterK = last.swap_key;
  }
  return written;
}

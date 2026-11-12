import { createHash } from "node:crypto";

/**
 * NEAR Intents settlement duration: the BigQuery query that would read the block time of the NEAR transactions a swap
 * names in `nearTxHashes`. DESIGN ONLY: nothing here creates a billed job. A billed run needs the owner's approval of the
 * exact SQL digest and byte ceiling (docs/intents/APPROVAL-settlement.md).
 *
 * Why this shape (all from free table metadata and dry runs):
 *  - `transactions` is day-partitioned on `block_date` and NOT clustered, so the only pruning is the partition range; a
 *    hash filter does not reduce the bytes read. Bytes = (columns read) x (days in the range).
 *  - Only two columns are read: `transaction_hash` (STRING) and `block_timestamp` (INT64, nanoseconds since epoch).
 *  - The hashes (214,026 for 7 days, 1,063,602 for 30) are too many for one query parameter (10 MB request limit) and
 *    batching them would re-scan the same partitions once per batch, so they are loaded ONCE into a scratch table with a
 *    free load job and joined: one scan per window.
 *  - The range is [first swap day, last swap day + 2 days): one slack day for settlement after midnight UTC.
 */
export const TX_TABLE = "bigquery-public-data.crypto_near_mainnet_us.transactions";

export interface SettlementWindow {
  id: string;
  /** First and last UTC day of swap creation (inclusive). */
  swapFrom: string;
  swapTo: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Exclusive upper bound of the partition range for a window. */
export const partitionEnd = (w: SettlementWindow): string => addDays(w.swapTo, 2);

function check(w: SettlementWindow): void {
  if (!DAY.test(w.swapFrom) || !DAY.test(w.swapTo) || w.swapFrom > w.swapTo)
    throw new Error("settlement window must be YYYY-MM-DD..YYYY-MM-DD, from <= to");
}

/** The approval form: joins a scratch table of the swaps' hashes (`<project>.<dataset>.<table>`, column `h`). */
export function settlementSql(w: SettlementWindow, scratchTable: string): string {
  check(w);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/.test(scratchTable))
    throw new Error("scratch table must be project.dataset.table");
  return `SELECT t.transaction_hash AS tx_hash, t.block_timestamp AS block_ts_ns
FROM \`${TX_TABLE}\` AS t
WHERE t.block_date >= DATE '${w.swapFrom}' AND t.block_date < DATE '${partitionEnd(w)}'
  AND t.transaction_hash IN (SELECT h FROM \`${scratchTable}\`)`;
}

/** The dry-run form: identical scan (same table, columns, partition range), the hash filter inlined for a few sample hashes. */
export function settlementDrySql(w: SettlementWindow, sampleHashes: string[]): string {
  check(w);
  if (sampleHashes.length === 0 || sampleHashes.some((h) => !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h)))
    throw new Error("sample hashes must be base58 transaction hashes");
  const list = sampleHashes.map((h) => `'${h}'`).join(", ");
  return `SELECT t.transaction_hash AS tx_hash, t.block_timestamp AS block_ts_ns
FROM \`${TX_TABLE}\` AS t
WHERE t.block_date >= DATE '${w.swapFrom}' AND t.block_date < DATE '${partitionEnd(w)}'
  AND t.transaction_hash IN (${list})`;
}

export const sqlDigest = (sql: string): string => createHash("sha256").update(sql).digest("hex");

/** After the join: duration = block time of the settling transaction minus swap createdAt (computed in ClickHouse, not BigQuery). */
export const SETTLEMENT_DEFINITION =
  "settlement_ms = max(block_ts_ns over the swap's nearTxHashes found in `transactions`) / 1e6 - createdAt(ms). Public-era swaps only (created before 2026-10-27T00:00Z; later nearTxHashes are shield/unshield boundary hashes, not the swap). A swap with any hash not found is excluded and counted, never zero-filled.";

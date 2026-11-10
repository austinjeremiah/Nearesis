import { IngestionError } from "../errors.ts";
import { NEAR_DATASET } from "../adapters/bigquery-guard.ts";
import type { Chunk } from "./plan.ts";
import { RECEIVER_THRESHOLD } from "./plan.ts";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const need = (d: string): string => {
  if (!DAY_RE.test(d))
    throw new IngestionError("INVALID_INPUT", false, { reason: "date must be YYYY-MM-DD" });
  return d;
};

/** Daily transactions + distinct signers (a signer proxy, never "users"). Finite block_date bounds always. */
export function transactionsSql(c: Pick<Chunk, "from" | "to">): string {
  return [
    "SELECT t.block_date AS block_date,",
    "  COUNT(*) AS tx_count,",
    "  COUNT(DISTINCT t.signer_account_id) AS distinct_signers",
    `FROM \`bigquery-public-data.${NEAR_DATASET}.transactions\` t`,
    `WHERE t.block_date >= DATE '${need(c.from)}' AND t.block_date < DATE '${need(c.to)}'`,
    "GROUP BY block_date ORDER BY block_date",
  ].join("\n");
}

/**
 * Function-call interactions per receiver-day. Receivers with fewer than `threshold` calls that day are folded into one
 * NULL-receiver row per day carrying their exact receiver count and interactions, so daily totals stay exact.
 * Bytes scanned are the same as the unfiltered query; only the output is reduced.
 */
export function receiversSql(c: Pick<Chunk, "from" | "to">, threshold: number = RECEIVER_THRESHOLD): string {
  if (!Number.isInteger(threshold) || threshold < 1)
    throw new IngestionError("INVALID_INPUT", false, { reason: "threshold must be a positive integer" });
  return [
    "WITH per_receiver AS (",
    "  SELECT a.block_date AS block_date, a.receipt_receiver_account_id AS receiver, COUNT(*) AS n",
    `  FROM \`bigquery-public-data.${NEAR_DATASET}.receipt_actions\` a`,
    `  WHERE a.block_date >= DATE '${need(c.from)}' AND a.block_date < DATE '${need(c.to)}'`,
    "    AND a.action_kind = 'FUNCTION_CALL'",
    "  GROUP BY block_date, receiver",
    ")",
    "SELECT block_date,",
    `  IF(n >= ${threshold}, receiver, NULL) AS receiver_out,`,
    "  SUM(n) AS interactions,",
    "  COUNT(*) AS receiver_count",
    "FROM per_receiver",
    "GROUP BY 1, 2",
    "ORDER BY 1, 2",
  ].join("\n");
}

export const chunkSql = (c: Chunk): string =>
  c.family === "transactions" ? transactionsSql(c) : receiversSql(c);

/** Bytes billed since `sinceIso` by every job of the project in `region` (e.g. region-us-east1). */
export function billedSinceSql(region: string, sinceIso: string): string {
  if (!/^[a-z0-9-]+$/.test(region))
    throw new IngestionError("INVALID_INPUT", false, { reason: "bad region" });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(sinceIso))
    throw new IngestionError("INVALID_INPUT", false, { reason: "bad timestamp" });
  return [
    "SELECT COALESCE(SUM(total_bytes_billed), 0) AS billed_bytes, COUNT(*) AS jobs",
    `FROM \`region-${region}\`.INFORMATION_SCHEMA.JOBS_BY_PROJECT`,
    `WHERE creation_time >= TIMESTAMP '${sinceIso}' AND total_bytes_billed IS NOT NULL`,
  ].join("\n");
}

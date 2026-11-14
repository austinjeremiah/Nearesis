import { IngestionError } from "../errors.ts";
import { NEAR_DATASET } from "../adapters/bigquery-guard.ts";
import { addDays, monthRanges, WINDOW_FROM, WINDOW_TO } from "./plan.ts";

/**
 * Documented, versioned rule for "Intents-generated" and "bridge-generated" transactions (ch.08: excluded from the organic
 * target by documented rule, not by a bot classifier). A transaction is classified by its receiver account:
 *   intents_verifier: receiver is the Intents verifier contract;
 *   bridge:           receiver is a bridge / omni-token contract (HOT omni bridge, omft tokens).
 * Everything else is organic. Private/off-chain intents are not observable and are not assumed zero (measurement limit).
 * Change the lists only together with a new ACCOUNT_RULE_VERSION and a reload of the affected days.
 */
export const ACCOUNT_RULE_VERSION = 1;
export const INTENTS_VERIFIER_RECEIVERS: readonly string[] = ["intents.near", "verifier2.near"];
export const BRIDGE_RECEIVERS: readonly string[] = ["bridge.near", "omft.near", "v2_1.omni.hot.tg"];
export const BRIDGE_RECEIVER_SUFFIXES: readonly string[] = [".omft.near"];
/** Signers with at least this many transactions in a day get a named row (the long tail is never stored per account). */
export const HEAVY_SIGNER_THRESHOLD = 1000;

export interface AccountChunk {
  id: string; // `account:${from}`
  from: string; // inclusive
  to: string; // exclusive
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const need = (d: string): string => {
  if (!DAY_RE.test(d))
    throw new IngestionError("INVALID_INPUT", false, { reason: "date must be YYYY-MM-DD" });
  return d;
};
const lit = (s: string): string => {
  if (!/^[a-z0-9._-]+$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "bad account literal" });
  return `'${s}'`;
};

/** Newest month first (recent data is the most valuable if quota runs out), monthly chunks, resumable by id. */
export function planAccountChunks(from = WINDOW_FROM, to = WINDOW_TO): AccountChunk[] {
  return monthRanges(from, to)
    .reverse()
    .map((m) => ({ id: `account:${m.from}`, from: m.from, to: m.to }));
}

/**
 * One scan of `transactions` (signer + receiver columns, finite block_date bounds). Output rows have kind = 'day' (exact
 * per-day aggregates incl. top-1% / top-5% organic signer concentration) or kind = 'signer' (heavy signers only).
 * Top-p% = the ceil(p% x organic signers) signers with the most organic transactions that day (ties by account id).
 * No OR keyword is used (the static guard rejects it in WHERE clauses).
 */
export function accountSql(
  c: Pick<AccountChunk, "from" | "to">,
  heavy: number = HEAVY_SIGNER_THRESHOLD,
): string {
  if (!Number.isInteger(heavy) || heavy < 1)
    throw new IngestionError("INVALID_INPUT", false, {
      reason: "heavy threshold must be a positive integer",
    });
  const verifier = INTENTS_VERIFIER_RECEIVERS.map(lit).join(", ");
  const bridge = BRIDGE_RECEIVERS.map(lit).join(", ");
  const suffixes = BRIDGE_RECEIVER_SUFFIXES.map(
    (s) => `CAST(ENDS_WITH(t.receiver_account_id, ${lit(s)}) AS INT64)`,
  ).join(", ");
  return [
    "WITH tx AS (",
    "  SELECT t.block_date AS block_date, t.signer_account_id AS signer,",
    `    t.receiver_account_id IN (${verifier}) AS is_intents,`,
    `    GREATEST(CAST(t.receiver_account_id IN (${bridge}) AS INT64), ${suffixes}) = 1 AS is_bridge`,
    `  FROM \`bigquery-public-data.${NEAR_DATASET}.transactions\` t`,
    `  WHERE t.block_date >= DATE '${need(c.from)}' AND t.block_date < DATE '${need(c.to)}'`,
    "), s AS (",
    "  SELECT block_date, signer, COUNT(*) AS n, COUNTIF(is_intents) AS n_int, COUNTIF(is_bridge AND NOT is_intents) AS n_br",
    "  FROM tx GROUP BY block_date, signer",
    "), r AS (",
    "  SELECT block_date, signer, n, n_int, n_br, n - n_int - n_br AS n_org FROM s",
    "), ranked AS (",
    "  SELECT block_date, n_org,",
    "    ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n_org DESC, signer) AS rk,",
    "    COUNT(*) OVER (PARTITION BY block_date) AS cnt",
    "  FROM r WHERE n_org > 0",
    "), org AS (",
    "  SELECT block_date, COUNT(*) AS signers_organic,",
    "    COUNTIF(rk <= CEIL(cnt * 0.01)) AS top1_count, SUM(IF(rk <= CEIL(cnt * 0.01), n_org, 0)) AS top1_tx,",
    "    COUNTIF(rk <= CEIL(cnt * 0.05)) AS top5_count, SUM(IF(rk <= CEIL(cnt * 0.05), n_org, 0)) AS top5_tx",
    "  FROM ranked GROUP BY block_date",
    "), tot AS (",
    "  SELECT block_date, SUM(n) AS tx_total, SUM(n_int) AS tx_intents, SUM(n_br) AS tx_bridge,",
    "    COUNT(*) AS signers_total, COUNTIF(n_int > 0) AS signers_with_intents",
    "  FROM r GROUP BY block_date",
    ")",
    "SELECT 'day' AS kind, tot.block_date AS block_date, CAST(NULL AS STRING) AS signer,",
    "  tot.tx_total, tot.tx_intents, tot.tx_bridge, tot.signers_total, tot.signers_with_intents,",
    "  COALESCE(org.signers_organic, 0) AS signers_organic,",
    "  COALESCE(org.top1_count, 0) AS top1_count, COALESCE(org.top1_tx, 0) AS top1_tx,",
    "  COALESCE(org.top5_count, 0) AS top5_count, COALESCE(org.top5_tx, 0) AS top5_tx",
    "FROM tot LEFT JOIN org USING (block_date)",
    "UNION ALL",
    "SELECT 'signer', block_date, signer, n, n_int, n_br, NULL, NULL, NULL, NULL, NULL, NULL, NULL",
    `FROM r WHERE n >= ${heavy}`,
    "ORDER BY 1, 2, 3",
  ].join("\n");
}

export { addDays };

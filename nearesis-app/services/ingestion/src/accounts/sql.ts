import { createHash } from "node:crypto";
import { IngestionError } from "../errors.ts";
import { NEAR_DATASET } from "../adapters/bigquery-guard.ts";
import {
  ACCOUNT_RULE_VERSION,
  BRIDGE_RECEIVERS,
  BRIDGE_RECEIVER_SUFFIXES,
  INTENTS_VERIFIER_RECEIVERS,
} from "../backfill/account-sql.ts";
import { addDays, WINDOW_FROM } from "../backfill/plan.ts";

/**
 * Per-signer account and cohort scan (A23). ONE read of `transactions` (block_date, signer_account_id, receiver_account_id)
 * over a finite block_date range; every output below derives from the same grouped CTE, so bytes are those of one scan.
 *
 * Output (one result set; `kind` selects the row shape, v1..v8 are INT64):
 *   head       key=signer          v1=n_org                         organic tx of a head signer that day (n_org >= head threshold)
 *   day_a      key=NULL            v1 signers_all, v2 tx_all, v3 tx_intents, v4 tx_bridge, v5 signers_with_intents,
 *                                  v6 signers_org, v7 tx_org, v8 top10_tx
 *   day_b      key=NULL            v1 tail_signers, v2 tail_tx (organic signers below the threshold: the exact per-day remainder),
 *                                  v3 new_signers, v4 new_tx (first organic day in the window), v5 top1_count, v6 top1_tx,
 *                                  v7 top5_count, v8 top5_tx
 *   entity     key=bucket          v1 signers_all, v2 tx_all, v3 signers_org, v4 tx_org   (bucket = entity id, or __unclassified__,
 *                                  __unverified__, __ambiguous__)
 *   retention  key=cohort_week     block_date = active week (Monday), v1 = distinct organic signers of that cohort active that week
 *   profile    key=signer          block_date = first organic day in the window, v1 = last organic day (UNIX_DATE), v2 = active days,
 *                                  v3 = organic tx, v4 = days as head signer      (only for signers that were ever head signers)
 *
 * Window-start limitation (explicit): "new" means first organic transaction SEEN SINCE the window start, not lifetime
 * first-seen. On the first window day every active signer is "new" by construction; that day is not a measure of growth.
 *
 * Entity attribution mirrors services/analytics/src/entities/attribution.ts: per (receiver, day) exact beats suffix, longer suffix
 * beats shorter, then lower precedence; equal rank across different entities is __ambiguous__ (never counted); an unverified
 * winner goes to __unverified__; no mapping -> __unclassified__. Only verified/inferred winners reach a named entity.
 * A signer touching several buckets in one day is counted once in EACH bucket: bucket distinct counts are not additive.
 *
 * Organic = not an Intents verifier receiver and not a bridge/omni receiver (the research-target definition, ACCOUNT_RULE_VERSION).
 * No OR keyword is used anywhere (the static guard rejects OR after any WHERE).
 */
export const ACCOUNT_SCAN_VERSION = 1;
export const HEAD_THRESHOLD = 100;
export const SPECIAL_BUCKETS = ["__unclassified__", "__unverified__", "__ambiguous__"] as const;

export interface MappingInput {
  mappingId: string;
  entityId: string;
  network: string;
  matchType: "exact" | "suffix";
  account: string;
  effectiveFrom: string; // ISO timestamp
  effectiveTo: string | null; // exclusive, ISO timestamp
  verification: "verified" | "inferred" | "unverified";
  precedence: number;
}

export interface AccountScanChunk {
  id: string;
  from: string; // inclusive
  to: string; // exclusive
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const day = (d: string): string => {
  if (!DAY_RE.test(d))
    throw new IngestionError("INVALID_INPUT", false, { reason: "date must be YYYY-MM-DD" });
  return d;
};
const lit = (s: string): string => {
  if (!/^[a-z0-9._-]+$/.test(s)) throw new IngestionError("INVALID_INPUT", false, { reason: "bad literal" });
  if (/^or$/i.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "literal collides with guard" });
  return `'${s}'`;
};
const litId = (s: string): string => {
  if (!/^[a-z0-9._:-]+$/.test(s))
    throw new IngestionError("INVALID_INPUT", false, { reason: "bad id literal" });
  return `'${s}'`;
};
const ts = (iso: string): string => {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso);
  if (!m) throw new IngestionError("INVALID_INPUT", false, { reason: "bad timestamp" });
  return `TIMESTAMP '${m[1]} ${m[2]}+00'`;
};

/** The registry rows embedded in the query, canonically sorted (so the digest does not depend on read order). */
export function mappingTable(ms: MappingInput[], network = "near"): string {
  const rows = ms.filter((m) => m.network === network).sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  if (rows.length === 0)
    throw new IngestionError("INVALID_INPUT", false, { reason: "no mappings for the network" });
  if (!Number.isInteger(rows[0]?.precedence ?? 0))
    throw new IngestionError("INVALID_INPUT", false, { reason: "precedence must be an integer" });
  return rows
    .map((m) => {
      if (!Number.isInteger(m.precedence) || m.precedence < 0)
        throw new IngestionError("INVALID_INPUT", false, {
          reason: "precedence must be a non-negative integer",
        });
      if (
        !["exact", "suffix"].includes(m.matchType) ||
        !["verified", "inferred", "unverified"].includes(m.verification)
      )
        throw new IngestionError("INVALID_INPUT", false, { reason: "bad match type or verification" });
      return `    STRUCT(${litId(m.mappingId)} AS mapping_id, ${lit(m.entityId)} AS entity_id, ${lit(m.matchType)} AS match_type, ${lit(m.account)} AS account, ${ts(m.effectiveFrom)} AS eff_from, ${m.effectiveTo ? ts(m.effectiveTo) : "CAST(NULL AS TIMESTAMP)"} AS eff_to, ${lit(m.verification)} AS verification, ${m.precedence} AS precedence)`;
    })
    .join(",\n");
}

/** One chunk covering [from, to). New-signer counts are anchored at `from`: only a chunk starting at the window start is "since window start". */
export function accountScanSql(
  c: Pick<AccountScanChunk, "from" | "to">,
  mappings: MappingInput[],
  head: number = HEAD_THRESHOLD,
): string {
  if (!Number.isInteger(head) || head < 2)
    throw new IngestionError("INVALID_INPUT", false, { reason: "head threshold must be an integer >= 2" });
  const verifier = INTENTS_VERIFIER_RECEIVERS.map(lit).join(", ");
  const bridge = BRIDGE_RECEIVERS.map(lit).join(", ");
  const suffixes = BRIDGE_RECEIVER_SUFFIXES.map((s) => `CAST(ENDS_WITH(receiver, ${lit(s)}) AS INT64)`).join(
    ", ",
  );
  const H = String(head);
  return [
    "WITH s AS (",
    "  SELECT t.block_date AS block_date, t.signer_account_id AS signer, t.receiver_account_id AS receiver, COUNT(*) AS n",
    `  FROM \`bigquery-public-data.${NEAR_DATASET}.transactions\` t`,
    `  WHERE t.block_date >= DATE '${day(c.from)}' AND t.block_date < DATE '${day(c.to)}'`,
    "  GROUP BY block_date, signer, receiver",
    "), sc AS (",
    "  SELECT block_date, signer, receiver, n,",
    "    CASE WHEN receiver IN (" + verifier + ") THEN 'intents'",
    `      WHEN GREATEST(CAST(receiver IN (${bridge}) AS INT64), ${suffixes}) = 1 THEN 'bridge'`,
    "      ELSE 'organic' END AS cls",
    "  FROM s",
    "), mp AS (",
    "  SELECT * FROM UNNEST([",
    mappingTable(mappings),
    "  ])",
    "), rcv AS (",
    "  SELECT DISTINCT receiver FROM s",
    "), cand AS (",
    "  SELECT r.receiver AS receiver, m.entity_id AS entity_id, m.verification AS verification, m.precedence AS precedence,",
    "    m.eff_from AS eff_from, m.eff_to AS eff_to, 1000000 AS spec",
    "  FROM rcv r JOIN mp m ON m.match_type = 'exact' AND m.account = r.receiver",
    "  UNION ALL",
    "  SELECT r.receiver, m.entity_id, m.verification, m.precedence, m.eff_from, m.eff_to, LENGTH(m.account)",
    "  FROM rcv r JOIN mp m ON m.match_type = 'suffix' AND ENDS_WITH(r.receiver, m.account) AND LENGTH(r.receiver) > LENGTH(m.account)",
    "), rd AS (",
    "  SELECT DISTINCT block_date, receiver FROM s",
    "), eff AS (",
    "  SELECT rd.block_date AS block_date, c.receiver AS receiver, c.entity_id AS entity_id, c.verification AS verification,",
    "    RANK() OVER (PARTITION BY rd.block_date, c.receiver ORDER BY c.spec DESC, c.precedence ASC) AS rk",
    "  FROM rd JOIN cand c ON c.receiver = rd.receiver",
    "  WHERE TIMESTAMP(rd.block_date) >= c.eff_from AND COALESCE(c.eff_to, TIMESTAMP '9999-12-31 00:00:00+00') > TIMESTAMP(rd.block_date)",
    "), win AS (",
    "  SELECT block_date, receiver, COUNT(DISTINCT entity_id) AS n_ent, MIN(entity_id) AS entity_id,",
    "    IF(COUNTIF(verification = 'unverified') > 0, 'unverified', IF(COUNTIF(verification = 'inferred') > 0, 'inferred', 'verified')) AS verification",
    "  FROM eff WHERE rk = 1 GROUP BY block_date, receiver",
    "), rb AS (",
    "  SELECT block_date, receiver,",
    "    CASE WHEN n_ent > 1 THEN '__ambiguous__' WHEN verification = 'unverified' THEN '__unverified__' ELSE entity_id END AS bucket",
    "  FROM win",
    "), sb AS (",
    "  SELECT sc.block_date AS block_date, sc.signer AS signer, sc.cls AS cls, sc.n AS n, COALESCE(rb.bucket, '__unclassified__') AS bucket",
    "  FROM sc LEFT JOIN rb ON rb.block_date = sc.block_date AND rb.receiver = sc.receiver",
    "), d AS (",
    "  SELECT block_date, signer, SUM(n) AS n_all, SUM(IF(cls = 'organic', n, 0)) AS n_org,",
    "    SUM(IF(cls = 'intents', n, 0)) AS n_int, SUM(IF(cls = 'bridge', n, 0)) AS n_br",
    "  FROM sc GROUP BY block_date, signer",
    "), o AS (",
    "  SELECT block_date, signer, n_org FROM d WHERE n_org > 0",
    "), fs AS (",
    "  SELECT signer, MIN(block_date) AS first_day FROM o GROUP BY signer",
    "), ranked AS (",
    "  SELECT o.block_date AS block_date, o.signer AS signer, o.n_org AS n_org, (o.block_date = fs.first_day) AS is_new,",
    "    ROW_NUMBER() OVER (PARTITION BY o.block_date ORDER BY o.n_org DESC, o.signer) AS rk,",
    "    COUNT(*) OVER (PARTITION BY o.block_date) AS cnt",
    "  FROM o JOIN fs ON fs.signer = o.signer",
    "), da AS (",
    "  SELECT block_date, COUNT(*) AS signers_all, SUM(n_all) AS tx_all, SUM(n_int) AS tx_int, SUM(n_br) AS tx_br,",
    "    COUNTIF(n_int > 0) AS signers_with_intents",
    "  FROM d GROUP BY block_date",
    "), db AS (",
    "  SELECT block_date, ANY_VALUE(cnt) AS signers_org, SUM(n_org) AS tx_org,",
    "    SUM(IF(rk <= 10, n_org, 0)) AS top10_tx,",
    `    COUNTIF(n_org < ${H}) AS tail_signers, SUM(IF(n_org < ${H}, n_org, 0)) AS tail_tx,`,
    "    COUNTIF(is_new) AS new_signers, SUM(IF(is_new, n_org, 0)) AS new_tx,",
    "    COUNTIF(rk <= CEIL(cnt * 0.01)) AS top1_count, SUM(IF(rk <= CEIL(cnt * 0.01), n_org, 0)) AS top1_tx,",
    "    COUNTIF(rk <= CEIL(cnt * 0.05)) AS top5_count, SUM(IF(rk <= CEIL(cnt * 0.05), n_org, 0)) AS top5_tx",
    "  FROM ranked GROUP BY block_date",
    "), ent AS (",
    "  SELECT block_date, bucket, COUNT(DISTINCT signer) AS signers_all, SUM(n) AS tx_all,",
    "    COUNT(DISTINCT IF(cls = 'organic', signer, NULL)) AS signers_org, SUM(IF(cls = 'organic', n, 0)) AS tx_org",
    "  FROM sb GROUP BY block_date, bucket",
    "), ret AS (",
    "  SELECT DATE_TRUNC(fs.first_day, WEEK(MONDAY)) AS cohort_week, DATE_TRUNC(o.block_date, WEEK(MONDAY)) AS active_week,",
    "    COUNT(DISTINCT o.signer) AS signers",
    "  FROM o JOIN fs ON fs.signer = o.signer GROUP BY cohort_week, active_week",
    "), hp AS (",
    `  SELECT signer, MIN(block_date) AS first_day, MAX(block_date) AS last_day, COUNT(*) AS head_days FROM o WHERE n_org >= ${H} GROUP BY signer`,
    "), prof AS (",
    "  SELECT hp.signer AS signer, fs.first_day AS first_day, MAX(o.block_date) AS last_day, COUNT(*) AS active_days,",
    "    SUM(o.n_org) AS tx_org, ANY_VALUE(hp.head_days) AS head_days",
    "  FROM hp JOIN fs ON fs.signer = hp.signer JOIN o ON o.signer = hp.signer GROUP BY hp.signer, fs.first_day",
    ")",
    "SELECT 'head' AS kind, block_date, signer AS key, n_org AS v1, CAST(NULL AS INT64) AS v2, CAST(NULL AS INT64) AS v3, CAST(NULL AS INT64) AS v4,",
    "  CAST(NULL AS INT64) AS v5, CAST(NULL AS INT64) AS v6, CAST(NULL AS INT64) AS v7, CAST(NULL AS INT64) AS v8",
    `FROM o WHERE n_org >= ${H}`,
    "UNION ALL",
    "SELECT 'day_a', da.block_date, CAST(NULL AS STRING), da.signers_all, da.tx_all, da.tx_int, da.tx_br, da.signers_with_intents,",
    "  COALESCE(db.signers_org, 0), COALESCE(db.tx_org, 0), COALESCE(db.top10_tx, 0)",
    "FROM da LEFT JOIN db ON db.block_date = da.block_date",
    "UNION ALL",
    "SELECT 'day_b', block_date, CAST(NULL AS STRING), tail_signers, tail_tx, new_signers, new_tx, top1_count, top1_tx, top5_count, top5_tx",
    "FROM db",
    "UNION ALL",
    "SELECT 'entity', block_date, bucket, signers_all, tx_all, signers_org, tx_org, NULL, NULL, NULL, NULL FROM ent",
    "UNION ALL",
    "SELECT 'retention', active_week, CAST(cohort_week AS STRING), signers, NULL, NULL, NULL, NULL, NULL, NULL, NULL FROM ret",
    "UNION ALL",
    "SELECT 'profile', first_day, signer, UNIX_DATE(last_day), active_days, tx_org, head_days, NULL, NULL, NULL, NULL FROM prof",
  ].join("\n");
}

/** Digest of the exact SQL text. The owner approves this digest; the billed runner must present it. */
export const sqlDigest = (sql: string): string => createHash("sha256").update(sql).digest("hex");

/** Month chunks, newest first (for dry-run reporting; see the single-pass note: new/returning needs the whole window in one job). */
export function monthChunks(from: string, toExclusive: string): AccountScanChunk[] {
  const out: AccountScanChunk[] = [];
  let cur = day(from);
  while (cur < toExclusive) {
    const [y, m] = cur.split("-").map(Number) as [number, number];
    const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const upper = next < toExclusive ? next : toExclusive;
    out.push({ id: `accounts:${cur}`, from: cur, to: upper });
    cur = upper;
  }
  return out.reverse();
}

export const WINDOW_END_EXCLUSIVE = addDays("2026-11-11", 1);
export { ACCOUNT_RULE_VERSION, WINDOW_FROM };

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  BRIDGE_RECEIVER_SUFFIXES,
  BRIDGE_RECEIVERS,
  INTENTS_VERIFIER_RECEIVERS,
} from "../../services/ingestion/src/backfill/account-sql.ts";
import { HEAD_THRESHOLD } from "../../services/ingestion/src/accounts/sql.ts";
import {
  compareIntSeries,
  missingDays,
  serializeRaw,
  sha256Hex,
  toPlainDecimal,
  withHeader,
  type RawColumn,
} from "./data-lib.ts";

/**
 * pnpm thesis:data [--bigquery]
 * Re-freezes thesis/raw from the local ClickHouse database `nearesis_live` (SELECT only, read-only session) for the reference
 * forecast thesis. Deterministic: identical data gives identical files, hashes and manifest (frozenAt and methodFrozenAt are kept
 * when nothing changed). `--bigquery` ALSO runs the billed BigQuery cross-check queries (dry run first, see
 * services/ingestion/src/thesis/bq-run-cli.ts); without it the existing BigQuery result files are only read.
 */
const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THESIS = process.env.NEARESIS_THESIS_DATA_DIR ?? join(APP, "thesis");
export const FROM = "2025-11-10"; // earliest full day held in every account table
export const TO = "2026-11-13"; // last full day (swaps through 2026-11-14 are partial and are not used)
const BREAK_DAY = "2026-04-02";
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { bigquery: { type: "boolean", default: false } },
});

const CH_URL = process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123";
async function ch(query: string): Promise<Record<string, string | null>[]> {
  const u = new URL(CH_URL);
  u.searchParams.set("param_s", FROM);
  u.searchParams.set("param_e", TO);
  u.searchParams.set("readonly", "2");
  u.searchParams.set("default_format", "JSONEachRow");
  for (const k of [
    "output_format_json_quote_64bit_integers",
    "output_format_json_quote_decimals",
    "output_format_json_quote_64bit_floats",
  ])
    u.searchParams.set(k, "1");
  const res = await fetch(u, {
    method: "POST",
    body: query,
    headers: {
      "X-ClickHouse-User": process.env.NEARESIS_CH_USER ?? "nearesis",
      "X-ClickHouse-Key": process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 300)}`);
  return text.trim() === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, string | null>);
}

// ---- the stablecoin set: the frozen research snapshot's set (docs/research/live-snapshots, read only) ----------------------
const SNAP = join(
  APP,
  "docs",
  "research",
  "live-snapshots",
  "live-20260505-20261111-live-organic-v3-3ac682146b75",
  "snapshot.json",
);
const STABLE: string[] = (JSON.parse(readFileSync(SNAP, "utf8")) as { stablecoinSet: { stable: string[] } })
  .stablecoinSet.stable;
const NEAR_TOKEN = ["NEAR", "wNEAR"];
const up = (xs: string[]): string => xs.map((x) => `'${x.toUpperCase()}'`).join(", ");

const PARTIAL = `created_day NOT IN (SELECT day FROM nearesis_live.source_coverage FINAL WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete')`;
const NULLUSD = `created_day NOT IN (SELECT created_day FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NULL)`;
const REG = `(SELECT provider_asset_id, symbol_observed, blockchain FROM nearesis_live.asset_registry FINAL)`;
const SWAP_WINDOW = `status = 'SUCCESS' AND amount_in_usd IS NOT NULL AND created_day BETWEEN {s:Date} AND {e:Date} AND ${PARTIAL} AND ${NULLUSD}`;
const LEGS = `FROM (SELECT created_day, origin_asset, destination_asset, amount_in_usd FROM nearesis_live.intents_swaps FINAL WHERE ${SWAP_WINDOW}) s
LEFT JOIN ${REG} o ON o.provider_asset_id = s.origin_asset
LEFT JOIN ${REG} dd ON dd.provider_asset_id = s.destination_asset`;

interface Def {
  id: string;
  title: string;
  unit: string;
  source: string;
  query: string;
  columns: RawColumn[];
  numeric: string[]; // columns normalised with toPlainDecimal
  definition: string;
  caveats: string[];
  /** true when the first column is a UTC day and a missing day is meaningful */
  daily: boolean;
  /** BigQuery cross-check source query id */
  bq: string | null;
  /** rows that carry null in the value column count as missing days */
  valueCol?: number;
}
const BQ_SRC =
  "BigQuery public dataset crypto_near_mainnet_us.transactions (ingested by the account scan into ClickHouse nearesis_live)";
const INTENTS_SRC = "Intents Explorer API (ingested into ClickHouse nearesis_live.intents_swaps)";
const dayCol: RawColumn = { name: "d", type: "date" };
const int = (name: string): RawColumn => ({ name, type: "integer-string" });
const dec = (name: string): RawColumn => ({ name, type: "decimal-string|null" });
const COMPLETE_NOTE =
  "Days whose swaps are marked partial in source_coverage (provider near-explorer, dataset intents_swaps: 2025-11-09 oldest edge, 2026-01-27/28/30 quarantined pages, 2026-04-02 to 2026-04-23 explorer cursor jump, 2026-07-23 quarantined page) are left out of this series entirely, and so are the two days (2026-02-02 and 2026-02-04) on which a successful swap has no USD value (the day is incomplete by the research definition); they are listed as missing days and never filled with zero or estimated.";
const NOT_ALL_INTENTS =
  "1Click swaps are not all NEAR Intents activity, and the Explorer shows only swaps it exposes; after 2026-10-27 private (shielded) settlement is not observed, so lower later values mean unobserved, not zero.";

const DEFS: Def[] = [
  {
    id: "intents_tx_daily",
    title: "F1 intents_tx: transactions per day addressed to the Intents contracts",
    unit: "transactions",
    source: BQ_SRC,
    query: `SELECT block_date AS d, tx_intents AS value
FROM nearesis_live.account_daily_activity FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [dayCol, int("value")],
    numeric: ["value"],
    daily: true,
    bq: "account_scan_daily",
    definition: `Transactions of the day whose receiver_account_id is one of ${INTENTS_VERIFIER_RECEIVERS.join(", ")} (the Intents verifier contracts; account rule version 1, services/ingestion/src/backfill/account-sql.ts), counted over ALL signers (head and tail). Bridge and omni-token receivers (${BRIDGE_RECEIVERS.join(", ")} and *${BRIDGE_RECEIVER_SUFFIXES.join(", *")}) are a separate class (tx_bridge) and are not in this count. A transaction is counted once, by its receiver.`,
    caveats: [
      "A transaction that reaches the Intents contracts through another contract (a cross-contract call) has another receiver and is not counted; only direct transactions to the verifier contracts are.",
      "After 2026-10-27 part of Intents settlement is private and is not visible on chain, so this count can understate Intents activity after that date.",
      "Successful and failed transactions cannot be told apart in the transactions table.",
    ],
  },
  {
    id: "tail_daily",
    title: "F2 tail_tx and F3 tail_signers: the long tail of ordinary accounts",
    unit: "transactions / accounts",
    source: BQ_SRC,
    query: `SELECT block_date AS d, tail_tx, tail_signers
FROM nearesis_live.account_daily_tail FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [dayCol, int("tail_tx"), int("tail_signers")],
    numeric: ["tail_tx", "tail_signers"],
    daily: true,
    bq: "account_scan_daily",
    definition: `Per signer and day, organic transactions n_org = all transactions minus those addressed to the Intents verifier contracts and minus bridge/omni receivers. The head is every signer with n_org >= ${HEAD_THRESHOLD} that day; the tail is every signer with 0 < n_org < ${HEAD_THRESHOLD}. tail_tx = sum of n_org over tail signers (organic transactions of accounts outside the heavy head); tail_signers = number of such signers. OVERLAP ANSWER: tail_tx does NOT contain Intents or bridge transactions, because those are removed before the head/tail split (tx_organic = tail_tx + head organic transactions exactly, checked on every day below). F2 therefore does not overlap F1 in transactions. The same accounts can appear in both series as signers (an account can sign an organic transaction and an Intents transaction on the same day); a signer with only Intents transactions on a day (n_org = 0) is in neither tail_signers nor the head.`,
    caveats: [
      "Accounts are signers, not people: one person can use several accounts and one account can be shared.",
      "The head threshold counts organic transactions only, so an account with fewer than 100 organic transactions but many Intents transactions is in the tail for F2/F3.",
      "The known 2026-04-02 break (two automated head accounts stopped) is outside this series by construction because the head is excluded; the break chart verifies it from the frozen data.",
    ],
  },
  {
    id: "transactions_daily",
    title: "Total, head and top-10 transactions per day",
    unit: "transactions",
    source: BQ_SRC,
    query: `SELECT a.block_date AS d, a.tx_total AS tx_total, a.signers_total AS signers_total, a.tx_organic AS tx_organic, a.signers_organic AS signers_organic, h.tx_head AS tx_head, n.top10_tx AS tx_top10
FROM nearesis_live.account_daily_activity a FINAL
JOIN (SELECT block_date, sum(tx_organic) AS tx_head FROM nearesis_live.account_daily_head FINAL GROUP BY block_date) h ON h.block_date = a.block_date
JOIN nearesis_live.account_daily_new_returning n FINAL ON n.block_date = a.block_date
WHERE a.block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [
      dayCol,
      int("tx_total"),
      int("signers_total"),
      int("tx_organic"),
      int("signers_organic"),
      int("tx_head"),
      int("tx_top10"),
    ],
    numeric: ["tx_total", "signers_total", "tx_organic", "signers_organic", "tx_head", "tx_top10"],
    daily: true,
    bq: "account_scan_daily",
    definition: `tx_total = every row of the transactions table for the block_date; signers_total = distinct signers; tx_organic / signers_organic = the same after removing Intents-verifier and bridge/omni receivers; tx_head = organic transactions of signers with n_org >= ${HEAD_THRESHOLD} that day (sum over account_daily_head); tx_top10 = organic transactions of the 10 organic signers with the most organic transactions that day.`,
    caveats: [
      "tx_total includes automated and Intents activity; it is not a measure of distinct users.",
      "Successful and failed transactions cannot be told apart.",
    ],
  },
  {
    id: "new_signers_daily",
    title: "New organic signers per day (first organic day seen since the window start)",
    unit: "accounts",
    source: BQ_SRC,
    query: `SELECT block_date AS d, new_signers AS value
FROM nearesis_live.account_daily_new_returning FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date} AND block_date > window_start
ORDER BY d`,
    columns: [dayCol, int("value")],
    numeric: ["value"],
    daily: true,
    bq: null,
    definition: `Organic signers (any size, tail and head) whose first organic transaction since the window start (${FROM}) falls on that day. "New" means first seen SINCE ${FROM}, not lifetime first-seen, so early days include returning accounts that had been inactive; the window-start day itself (every signer is new by construction) is left out and listed as a missing day. Head signers are a negligible share of the count (see head_accounts_break), so this is read as new long-tail signers.`,
    caveats: [
      "Accounts are not people. Because 'new' is relative to the window start, the level is inflated early in the window and falls as the pool of already-seen accounts grows; read it as a trend of newcomers, not a lifetime acquisition count.",
    ],
  },
  {
    id: "intents_volume_daily",
    title: "F4 intents_usd: USD volume of successful Intents swaps per day",
    unit: "USD",
    source: INTENTS_SRC,
    query: `SELECT created_day AS d,
  if(countIf(status = 'SUCCESS' AND amount_in_usd IS NULL) > 0, NULL, sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status = 'SUCCESS')) AS value
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date} AND ${PARTIAL}
GROUP BY d ORDER BY d`,
    columns: [dayCol, dec("value")],
    numeric: ["value"],
    daily: true,
    bq: null,
    definition: `Sum of amount_in_usd (the provider's USD value of the input amount, exact Decimal(76,18) sum) over swaps with status SUCCESS and a known USD value, by created_day (UTC): the research definition. A day with a SUCCESS swap whose USD is NULL would be null (none is in this window). ${COMPLETE_NOTE}`,
    caveats: [
      "SUCCESS-only excludes REFUNDED and FAILED swaps, which also excludes the four refunded swaps with absurd provider USD values (quarantined in usd-quarantine.ts).",
      "amount_in_usd is the provider's USD value at swap time, not an audited price.",
      NOT_ALL_INTENTS,
    ],
  },
  {
    id: "swaps_daily",
    title: "Successful Intents swaps per day and the median successful swap (USD)",
    unit: "swaps / USD",
    source: INTENTS_SRC,
    query: `SELECT created_day AS d, countIf(status = 'SUCCESS') AS success_swaps,
  quantileExactIf(0.5)(toFloat64(amount_in_usd), status = 'SUCCESS' AND amount_in_usd IS NOT NULL) AS median_usd
FROM nearesis_live.intents_swaps FINAL
WHERE created_day BETWEEN {s:Date} AND {e:Date} AND ${PARTIAL}
GROUP BY d ORDER BY d`,
    columns: [dayCol, int("success_swaps"), dec("median_usd")],
    numeric: ["success_swaps", "median_usd"],
    daily: true,
    bq: null,
    definition: `success_swaps = swaps with status SUCCESS per created_day (UTC); median_usd = the median amount_in_usd of successful swaps with a known USD value (ClickHouse quantileExact(0.5): the value at index floor(n/2) of the sorted amounts). ${COMPLETE_NOTE}`,
    caveats: [NOT_ALL_INTENTS],
  },
  {
    id: "intents_mix_daily",
    title:
      "What moves through Intents: stable-to-stable, no-NEAR-asset and NEAR-token shares of daily USD volume",
    unit: "USD / share",
    source: `${INTENTS_SRC} joined to the asset registry (nearesis_live.asset_registry)`,
    query: `SELECT d,
  sum(usd) AS total_usd,
  ifNull(sumIf(usd, stable), 0) AS stable_usd,
  ifNull(sumIf(usd, nonear), 0) AS no_near_usd,
  ifNull(sumIf(usd, neartok), 0) AS near_token_usd,
  ifNull(sumIf(usd, unk), 0) AS unknown_usd,
  toFloat64(ifNull(sumIf(usd, stable), 0)) / toFloat64(sum(usd)) AS stable_share,
  toFloat64(ifNull(sumIf(usd, nonear), 0)) / toFloat64(sum(usd)) AS no_near_share,
  toFloat64(ifNull(sumIf(usd, neartok), 0)) / toFloat64(sum(usd)) AS near_token_share,
  toFloat64(ifNull(sumIf(usd, unk), 0)) / toFloat64(sum(usd)) AS unknown_share
FROM (
  SELECT s.created_day AS d, s.amount_in_usd AS usd,
    (o.provider_asset_id IS NULL OR dd.provider_asset_id IS NULL) AS unk,
    (NOT unk AND upper(o.symbol_observed) IN (${up(STABLE)}) AND upper(dd.symbol_observed) IN (${up(STABLE)})) AS stable,
    (NOT unk AND o.blockchain != 'near' AND dd.blockchain != 'near') AS nonear,
    (NOT unk AND (upper(o.symbol_observed) IN (${up(NEAR_TOKEN)}) OR upper(dd.symbol_observed) IN (${up(NEAR_TOKEN)}))) AS neartok
  ${LEGS}
)
GROUP BY d ORDER BY d
SETTINGS join_use_nulls = 1`,
    columns: [
      dayCol,
      dec("total_usd"),
      dec("stable_usd"),
      dec("no_near_usd"),
      dec("near_token_usd"),
      dec("unknown_usd"),
      dec("stable_share"),
      dec("no_near_share"),
      dec("near_token_share"),
      dec("unknown_share"),
    ],
    numeric: [
      "total_usd",
      "stable_usd",
      "no_near_usd",
      "near_token_usd",
      "unknown_usd",
      "stable_share",
      "no_near_share",
      "near_token_share",
      "unknown_share",
    ],
    daily: true,
    bq: null,
    definition: `Volume = successful swaps with a known USD value (the F4 definition), per created_day (UTC). Each swap leg (origin_asset, destination_asset) is joined to nearesis_live.asset_registry on provider_asset_id. F5 stable_share: both legs are a stablecoin, by upper-cased registry symbol_observed in {${STABLE.join(", ")}} (the frozen research snapshot's stablecoinSet; USDT0 and USDCx variants count, a deprecated-suffix symbol does not). F6 no_near_share: both legs mapped and NEITHER leg has registry blockchain 'near' (a stablecoin or token issued on NEAR counts as a NEAR-chain asset). F7 near_token_share: either leg has symbol NEAR or wNEAR (asset ids listed in asset_sets: nep141:wrap.near is wNEAR on NEAR; the NEAR token on BNB chain is also listed; F6 and F7 can overlap only for that BNB-chain leg). unknown_share: a swap with an unmapped leg (no registry row) is counted in unknown_usd only, never in F5, F6 or F7; shares divide by total_usd including unknown. The registry rows are used regardless of valid_from: every row has valid_from 2026-05-01 (the registry load stamp, valid_to is null everywhere), and applying it as a validity start would wrongly unmap every swap before that date. Shares are the share of the day's USD volume, not of swap counts. ${COMPLETE_NOTE}`,
    caveats: [
      "USD amounts are the provider's value of the input amount and each leg's identity is the registry's: a wrong or missing registry row moves volume between classes. A swap whose two legs are the same asset (for example wNEAR to wNEAR) is counted as is.",
      "Stable-to-stable swaps include same-stablecoin cross-chain transfers (for example USDT on one chain to USDT on another), so the share measures stablecoin movement through Intents, not stablecoin trading alone.",
      NOT_ALL_INTENTS,
    ],
  },
  {
    id: "chain_pairs_monthly",
    title: "Monthly USD volume of the top 10 origin-chain to destination-chain pairs",
    unit: "USD",
    source: `${INTENTS_SRC} joined to the asset registry`,
    query: `WITH legs AS (
  SELECT toStartOfMonth(s.created_day) AS m, ifNull(o.blockchain, 'unmapped') AS origin_chain, ifNull(dd.blockchain, 'unmapped') AS destination_chain, s.amount_in_usd AS usd
  ${LEGS}
)
SELECT m, origin_chain, destination_chain, sum(usd) AS usd, count() AS swaps
FROM legs
WHERE (origin_chain, destination_chain) IN (SELECT origin_chain, destination_chain FROM legs GROUP BY origin_chain, destination_chain ORDER BY sum(usd) DESC, origin_chain, destination_chain LIMIT 10)
GROUP BY m, origin_chain, destination_chain
ORDER BY origin_chain, destination_chain, m
SETTINGS join_use_nulls = 1`,
    columns: [
      { name: "m", type: "date" },
      { name: "origin_chain", type: "string" },
      { name: "destination_chain", type: "string" },
      dec("usd"),
      int("swaps"),
    ],
    numeric: ["usd", "swaps"],
    daily: false,
    bq: null,
    definition: `USD volume (successful, known-USD swaps, same definition as F4, complete days only) by calendar month (m = first day of the month) and registry blockchain of the origin and destination asset; the ten pairs with the largest volume over the whole window are listed, each with the months where it has volume. 2025-11 starts on 2025-11-10 and 2026-11 ends on 2026-11-13: those two months are partial.`,
    caveats: [
      "A pair is by the blockchain of each asset in the registry (e.g. btc to eth), not by wallet. Months with no volume for a pair have no row (not zero-filled). " +
        COMPLETE_NOTE,
    ],
  },
  {
    id: "excursion_routes",
    title: "Routes with a NEAR-token leg, 2026-05-22 to 2026-05-27 (the May 2026 excursion)",
    unit: "USD",
    source: `${INTENTS_SRC} joined to the asset registry`,
    query: `SELECT ifNull(o.symbol_observed, 'unmapped') AS origin_symbol, ifNull(o.blockchain, 'unmapped') AS origin_chain,
  ifNull(dd.symbol_observed, 'unmapped') AS destination_symbol, ifNull(dd.blockchain, 'unmapped') AS destination_chain,
  count() AS swaps, sum(s.amount_in_usd) AS usd, quantileExact(0.5)(toFloat64(s.amount_in_usd)) AS median_usd
FROM (SELECT created_day, origin_asset, destination_asset, amount_in_usd FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS' AND amount_in_usd IS NOT NULL AND created_day BETWEEN '2026-05-22' AND '2026-05-27' AND ${PARTIAL}) s
LEFT JOIN ${REG} o ON o.provider_asset_id = s.origin_asset
LEFT JOIN ${REG} dd ON dd.provider_asset_id = s.destination_asset
WHERE upper(ifNull(o.symbol_observed, '')) IN (${up(NEAR_TOKEN)}) OR upper(ifNull(dd.symbol_observed, '')) IN (${up(NEAR_TOKEN)})
GROUP BY origin_symbol, origin_chain, destination_symbol, destination_chain
ORDER BY sum(s.amount_in_usd) DESC, origin_symbol, destination_symbol
LIMIT 10
SETTINGS join_use_nulls = 1`,
    columns: [
      { name: "origin_symbol", type: "string" },
      { name: "origin_chain", type: "string" },
      { name: "destination_symbol", type: "string" },
      { name: "destination_chain", type: "string" },
      int("swaps"),
      dec("usd"),
      dec("median_usd"),
    ],
    numeric: ["swaps", "usd", "median_usd"],
    daily: false,
    bq: null,
    definition:
      "The ten routes (origin asset to destination asset) with the most USD volume among successful known-USD swaps that have a NEAR or wNEAR leg, over 2026-05-22 to 2026-05-27, the days on which the near_token_share series peaks. Used only to explain that excursion.",
    caveats: [
      "A route here is a pair of registry symbols and blockchains. A swap of an asset for the same asset on the same chain shows an input value but a median close to zero when most such swaps are tiny.",
    ],
  },
  {
    id: "asset_sets",
    title: "The asset sets used for F5, F6 and F7 (registry rows)",
    unit: "assets",
    source: "Local asset registry (nearesis_live.asset_registry)",
    query: `SELECT 'stable' AS set_name, provider_asset_id, symbol_observed AS symbol, blockchain, verification
FROM nearesis_live.asset_registry FINAL WHERE upper(symbol_observed) IN (${up(STABLE)})
UNION ALL
SELECT 'near_token', provider_asset_id, symbol_observed, blockchain, verification
FROM nearesis_live.asset_registry FINAL WHERE upper(symbol_observed) IN (${up(NEAR_TOKEN)})
ORDER BY 1, 3, 4, 2`,
    columns: [
      { name: "set_name", type: "string" },
      { name: "provider_asset_id", type: "string" },
      { name: "symbol", type: "string" },
      { name: "blockchain", type: "string" },
      { name: "verification", type: "string" },
    ],
    numeric: [],
    daily: false,
    bq: null,
    definition: `Every registry row whose upper-cased symbol is in the stablecoin set {${STABLE.join(", ")}} (set_name stable) or is NEAR / wNEAR (set_name near_token).`,
    caveats: [
      "Some stablecoin rows are 'ambiguous' or 'unverified' in the registry; they are included because the research snapshot's set is by symbol.",
    ],
  },
  {
    id: "head_accounts_break",
    title: `Head accounts around ${BREAK_DAY}: transactions in the 31 days before and after`,
    unit: "transactions",
    source: BQ_SRC,
    query: `SELECT signer_account_id,
  countIf(block_date BETWEEN '2026-03-02' AND '2026-04-01') AS head_days_before,
  sumIf(tx_organic, block_date BETWEEN '2026-03-02' AND '2026-04-01') AS tx_before,
  sumIf(tx_organic, block_date BETWEEN '2026-03-02' AND '2026-04-01') / 31 AS avg_daily_before,
  countIf(block_date BETWEEN '2026-04-02' AND '2026-05-02') AS head_days_after,
  sumIf(tx_organic, block_date BETWEEN '2026-04-02' AND '2026-05-02') AS tx_after,
  sumIf(tx_organic, block_date BETWEEN '2026-04-02' AND '2026-05-02') / 31 AS avg_daily_after
FROM nearesis_live.account_daily_head FINAL
WHERE block_date BETWEEN '2026-03-02' AND '2026-05-02'
GROUP BY signer_account_id
ORDER BY greatest(tx_before, tx_after) DESC, signer_account_id
LIMIT 12`,
    columns: [
      { name: "signer_account_id", type: "string" },
      int("head_days_before"),
      int("tx_before"),
      dec("avg_daily_before"),
      int("head_days_after"),
      int("tx_after"),
      dec("avg_daily_after"),
    ],
    numeric: [
      "head_days_before",
      "tx_before",
      "avg_daily_before",
      "head_days_after",
      "tx_after",
      "avg_daily_after",
    ],
    daily: false,
    bq: null,
    definition: `The 12 head accounts (organic transactions >= ${HEAD_THRESHOLD} on a day) with the largest of their before and after totals. Before = 2026-03-02 to 2026-04-01 and after = 2026-04-02 to 2026-05-02, 31 days each. tx_* sums organic transactions on the days the account was in the head; avg_daily_* = that sum divided by 31. On a day below ${HEAD_THRESHOLD} organic transactions the account is not stored, so the averages are lower bounds for accounts that were in the head on fewer days than 31 (head_days_* says how many).`,
    caveats: [
      "Organic transactions only (Intents and bridge transactions are excluded by the account rule); automated accounts are identified by behaviour in the data, not by who runs them.",
    ],
  },
  {
    id: "near_price_daily",
    title: "NEAR daily close (USD)",
    unit: "USD per NEAR",
    source: "Price provider (CoinGecko free plan, ingested into ClickHouse nearesis_live.price_candles)",
    query: `SELECT day AS d, argMax(close_raw, bucket_start) AS value
FROM nearesis_live.price_candles FINAL
WHERE day BETWEEN {s:Date} AND {e:Date} AND \`interval\` = '1d' AND symbol = 'NEAR' AND quote_currency = 'usd'
GROUP BY d ORDER BY d`,
    columns: [dayCol, dec("value")],
    numeric: ["value"],
    daily: true,
    bq: null,
    definition:
      "The provider's last price sample of the UTC day (close_raw as received, exact string). The free plan has no daily OHLC history, so the day's candle is built from 24 hourly samples.",
    caveats: [
      "The 'close' is the last hourly sample of the day, not an official daily close; it is an aggregated provider quote, not a trade-weighted VWAP.",
    ],
  },
  {
    id: "swaps_coverage",
    title: "Days marked partial or incomplete in the swaps source coverage",
    unit: "days",
    source: "Local source coverage (nearesis_live.source_coverage)",
    query: `SELECT day AS d, state, ifNull(reason, '') AS reason
FROM nearesis_live.source_coverage FINAL
WHERE provider_id = 'near-explorer' AND dataset = 'intents_swaps' AND state != 'complete' AND day BETWEEN '2025-11-09' AND {e:Date}
ORDER BY d`,
    columns: [dayCol, { name: "state", type: "string" }, { name: "reason", type: "string" }],
    numeric: [],
    daily: false,
    bq: null,
    definition:
      "One row per day (2025-11-09 to the last day) on which the Explorer swap fetch is not complete. These days are excluded from every swap series (F4 to F8) and listed, never filled.",
    caveats: ["2026-11-14 (still filling, partial) is outside the window and not a row here."],
  },
];

// ---- BigQuery source queries (block_date filtered, DECLAREd bounds; the runner adds the execution record) ------------------
const BQ_END = "2026-11-14"; // exclusive
interface BqDef {
  id: string;
  title: string;
  description: string;
  body: string;
  /** columns holding INT64 per-day values used in cross-checks */
  columns: string[];
}
const lit = (s: string): string => `'${s}'`;
const verifierLit = INTENTS_VERIFIER_RECEIVERS.map(lit).join(", ");
const bridgeLit = BRIDGE_RECEIVERS.map(lit).join(", ");
const suffixLit = BRIDGE_RECEIVER_SUFFIXES.map(
  (s) => `CAST(ENDS_WITH(t.receiver_account_id, ${lit(s)}) AS INT64)`,
).join(", ");
const BQ: BqDef[] = [
  {
    id: "transactions_signers_daily",
    title: "Total transactions and distinct signers per day",
    description:
      "Every row of the transactions table per block_date, and the number of distinct signer_account_id (a signer proxy, not people).",
    columns: ["tx_count", "distinct_signers"],
    body: `DECLARE start_date DATE DEFAULT DATE '${FROM}';
DECLARE end_date DATE DEFAULT DATE '${BQ_END}';
SELECT t.block_date AS block_date,
  COUNT(*) AS tx_count,
  COUNT(DISTINCT t.signer_account_id) AS distinct_signers
FROM \`bigquery-public-data.crypto_near_mainnet_us.transactions\` t
WHERE t.block_date >= start_date AND t.block_date < end_date
GROUP BY block_date ORDER BY block_date
`,
  },
  {
    id: "account_scan_daily",
    title: "Intents, bridge, organic, head and tail transactions per day (the account scan, day level)",
    description: `Per signer and day, organic = not an Intents verifier receiver and not a bridge/omni receiver; head = signers with at least ${HEAD_THRESHOLD} organic transactions that day, tail = the other organic signers; top10 = the ten organic signers with the most organic transactions. Same rule as the local account scan (services/ingestion/src/accounts/sql.ts, account rule version 1), reduced to the day-level columns used by this thesis.`,
    columns: [
      "tx_total",
      "tx_intents",
      "tx_bridge",
      "tx_organic",
      "signers_organic",
      "tail_signers",
      "tail_tx",
      "head_tx",
      "top10_tx",
    ],
    body: `DECLARE start_date DATE DEFAULT DATE '${FROM}';
DECLARE end_date DATE DEFAULT DATE '${BQ_END}';
WITH tx AS (
  SELECT t.block_date AS block_date, t.signer_account_id AS signer,
    t.receiver_account_id IN (${verifierLit}) AS is_intents,
    GREATEST(CAST(t.receiver_account_id IN (${bridgeLit}) AS INT64), ${suffixLit}) = 1 AS is_bridge
  FROM \`bigquery-public-data.crypto_near_mainnet_us.transactions\` t
  WHERE t.block_date >= start_date AND t.block_date < end_date
), s AS (
  SELECT block_date, signer, COUNT(*) AS n, COUNTIF(is_intents) AS n_int, COUNTIF(is_bridge AND NOT is_intents) AS n_br
  FROM tx GROUP BY block_date, signer
), r AS (
  SELECT block_date, signer, n, n_int, n_br, n - n_int - n_br AS n_org FROM s
), ranked AS (
  SELECT block_date, n_org, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n_org DESC, signer) AS rk
  FROM r WHERE n_org > 0
), tot AS (
  SELECT block_date, SUM(n) AS tx_total, SUM(n_int) AS tx_intents, SUM(n_br) AS tx_bridge FROM r GROUP BY block_date
), org AS (
  SELECT block_date, COUNT(*) AS signers_organic, SUM(n_org) AS tx_organic,
    COUNTIF(n_org < ${HEAD_THRESHOLD}) AS tail_signers, SUM(IF(n_org < ${HEAD_THRESHOLD}, n_org, 0)) AS tail_tx,
    SUM(IF(n_org >= ${HEAD_THRESHOLD}, n_org, 0)) AS head_tx, SUM(IF(rk <= 10, n_org, 0)) AS top10_tx
  FROM ranked GROUP BY block_date
)
SELECT tot.block_date AS block_date, tot.tx_total, tot.tx_intents, tot.tx_bridge,
  COALESCE(org.tx_organic, 0) AS tx_organic, COALESCE(org.signers_organic, 0) AS signers_organic,
  COALESCE(org.tail_signers, 0) AS tail_signers, COALESCE(org.tail_tx, 0) AS tail_tx,
  COALESCE(org.head_tx, 0) AS head_tx, COALESCE(org.top10_tx, 0) AS top10_tx
FROM tot LEFT JOIN org ON org.block_date = tot.block_date
ORDER BY block_date
`,
  },
];
const REC_BEGIN = "-- ==== EXECUTION RECORD BEGIN ====";
const REC_END = "-- ==== EXECUTION RECORD END ====";
const MARK = "-- ---- query ----";

const readJson = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;

/** Writes sql/bigquery/<id>.sql with a NOT EXECUTED record unless the file already holds the same query (then it is kept). */
function ensureBqFile(b: BqDef): void {
  const path = join(THESIS, "sql", "bigquery", `${b.id}.sql`);
  const header = [
    `-- thesis BigQuery source query: ${b.id}`,
    `-- ${b.title}.`,
    `-- ${b.description}`,
    `-- Source: bigquery-public-data.crypto_near_mainnet_us.transactions (partitioned by block_date; both bounds are DECLAREd literals, end_date is exclusive).`,
    `-- Window: block_date ${FROM} .. ${TO} inclusive.`,
  ].join("\n");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (existing !== null) {
    const at = existing.indexOf(MARK);
    if (at >= 0 && existing.slice(at + MARK.length + 1) === b.body && existing.includes(REC_BEGIN)) return;
  }
  writeFileSync(
    path,
    `${header}\n${REC_BEGIN}\n-- status: NOT EXECUTED (run pnpm thesis:data --bigquery)\n${REC_END}\n${MARK}\n${b.body}`,
  );
  const stale = join(THESIS, "raw", `bq_${b.id}.json`);
  if (existsSync(stale)) rmSync(stale);
}

const prevManifest = readJson<{
  frozenAt: string;
  methodFrozenAt?: string;
  datasets: Array<{ id: string; sha256: string | null }>;
}>(join(THESIS, "raw", "manifest.json"));

mkdirSync(join(THESIS, "raw"), { recursive: true });
mkdirSync(join(THESIS, "sql", "executed"), { recursive: true });
mkdirSync(join(THESIS, "sql", "bigquery"), { recursive: true });
for (const b of BQ) ensureBqFile(b);

if (values.bigquery) {
  console.error("running billed BigQuery step (dry run first, quota-checked)...");
  execFileSync(
    "pnpm",
    ["--filter", "@nearesis/ingestion", "exec", "tsx", "src/thesis/bq-run-cli.ts", "--execute"],
    { cwd: APP, stdio: ["ignore", "inherit", "inherit"] },
  );
}

type BqRaw = {
  columns: RawColumn[];
  bigQuery: { jobId: string; location: string; executedAt: string; dryRunBytes: number; bytesBilled: string };
  rows: (string | null)[][];
};
const bqRaw = (id: string): BqRaw | null => {
  const p = join(THESIS, "raw", `bq_${id}.json`);
  if (!existsSync(p) || readFileSync(p, "utf8").trim() === "") return null;
  return JSON.parse(readFileSync(p, "utf8")) as BqRaw;
};

interface Frozen {
  def: Def;
  rows: (string | null)[][];
  text: string;
  sha: string;
}
const frozen: Frozen[] = [];
for (const def of DEFS) {
  const recs = await ch(def.query);
  const names = def.columns.map((c) => c.name);
  const rows = recs.map((r) =>
    names.map((n) => {
      const v = r[n] ?? null;
      return def.numeric.includes(n) ? toPlainDecimal(v) : v;
    }),
  );
  const text = serializeRaw(def.columns, rows);
  frozen.push({ def, rows, text, sha: sha256Hex(text) });
}
const byId = new Map(frozen.map((f) => [f.def.id, f]));

// BigQuery result files that are present and match the current query text
const bqState = BQ.map((b) => {
  const raw = bqRaw(b.id);
  const sqlText = readFileSync(join(THESIS, "sql", "bigquery", `${b.id}.sql`), "utf8");
  const executed = raw !== null && sqlText.includes("-- status: EXECUTED");
  return { b, raw: executed ? raw : null, sqlText };
});
const bqByCol = (id: string, col: string): Array<readonly [string, string | null]> => {
  const s = bqState.find((x) => x.b.id === id);
  if (!s?.raw) return [];
  const i = s.raw.columns.findIndex((c) => c.name === col);
  return s.raw.rows.map((r) => [String(r[0]), r[i] ?? null] as const);
};
const localCol = (id: string, col: string): Array<readonly [string, string | null]> => {
  const f = byId.get(id)!;
  const i = f.def.columns.findIndex((c) => c.name === col);
  return f.rows.map((r) => [String(r[0]), r[i] as string | null] as const);
};

const CHECKS: Array<[string, string, string, string]> = [
  ["transactions_daily", "tx_total", "transactions_signers_daily", "tx_count"],
  ["transactions_daily", "signers_total", "transactions_signers_daily", "distinct_signers"],
  ["transactions_daily", "tx_total", "account_scan_daily", "tx_total"],
  ["intents_tx_daily", "value", "account_scan_daily", "tx_intents"],
  ["transactions_daily", "tx_organic", "account_scan_daily", "tx_organic"],
  ["transactions_daily", "signers_organic", "account_scan_daily", "signers_organic"],
  ["tail_daily", "tail_tx", "account_scan_daily", "tail_tx"],
  ["tail_daily", "tail_signers", "account_scan_daily", "tail_signers"],
  ["transactions_daily", "tx_head", "account_scan_daily", "head_tx"],
  ["transactions_daily", "tx_top10", "account_scan_daily", "top10_tx"],
];
const crossChecks = bqState.some((s) => s.raw)
  ? CHECKS.filter(([, , bq]) => bqState.find((s) => s.b.id === bq)?.raw).map(([ld, lc, bq, bc]) => {
      const c = compareIntSeries(localCol(ld, lc), bqByCol(bq, bc));
      return {
        id: `${ld}.${lc}~${bq}.${bc}`,
        local: `${ld}.${lc}`,
        bigquery: `${bq}.${bc}`,
        daysLocal: c.daysLocal,
        daysBigQuery: c.daysOther,
        daysCompared: c.daysCompared,
        daysEqual: c.daysEqual,
        maxAbsDiff: Number(c.maxAbsDiff),
        maxAbsDiffDay: c.maxAbsDiffDay,
      };
    })
  : [];

// internal consistency checks on the local tables (exact, over every day)
const tx = byId.get("transactions_daily")!;
const tail = byId.get("tail_daily")!;
const tIdx = (n: string): number => tx.def.columns.findIndex((c) => c.name === n);
let consistent = 0;
const inconsistent: string[] = [];
for (const r of tx.rows) {
  const t = tail.rows.find((x) => x[0] === r[0]);
  const ok =
    t !== undefined && BigInt(r[tIdx("tx_organic")]!) === BigInt(t[1]!) + BigInt(r[tIdx("tx_head")]!);
  if (ok) consistent++;
  else inconsistent.push(String(r[0]));
}
const internalChecks = {
  organicEqualsHeadPlusTail: { days: tx.rows.length, daysEqual: consistent, daysDifferent: inconsistent },
};

const unchanged =
  prevManifest !== null &&
  prevManifest.datasets.length === frozen.length &&
  frozen.every((f) => prevManifest.datasets.find((d) => d.id === f.def.id)?.sha256 === f.sha);
const frozenAt = unchanged && prevManifest ? prevManifest.frozenAt : new Date().toISOString();
const methodFrozenAt = prevManifest?.methodFrozenAt ?? new Date().toISOString();

const bqQueries = bqState.map(({ b, raw, sqlText }) => ({
  id: b.id,
  title: b.title,
  sqlBigQuery: `sql/bigquery/${b.id}.sql`,
  executed: raw !== null,
  executedAt: raw?.bigQuery.executedAt ?? null,
  jobId: raw?.bigQuery.jobId ?? null,
  location: raw?.bigQuery.location ?? null,
  dryRunBytes: raw ? raw.bigQuery.dryRunBytes : null,
  bytesBilled: raw ? Number(raw.bigQuery.bytesBilled) : null,
  rows: raw ? raw.rows.length : null,
  resultFile: raw ? `raw/bq_${b.id}.json` : null,
  resultSha256: raw ? sha256Hex(readFileSync(join(THESIS, "raw", `bq_${b.id}.json`), "utf8")) : null,
  querySha256: sha256Hex(sqlText.slice(sqlText.indexOf(MARK) + MARK.length + 1)),
  note: raw ? null : "NOT EXECUTED: the SQL ships; the local series is used and no cross-check exists.",
}));

const datasets = frozen.map((f) => {
  const { def } = f;
  const b = def.bq ? bqQueries.find((q) => q.id === def.bq) : undefined;
  const file = `raw/${def.id}.json`;
  const missing = def.daily ? missingDays(f.rows, FROM, TO, def.valueCol ?? 1) : [];
  writeFileSync(join(THESIS, file), f.text);
  writeFileSync(
    join(THESIS, "sql", "executed", `${def.id}.sql`),
    withHeader(
      [
        `thesis dataset: ${def.id}  (${def.title})`,
        `executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)`,
        `frozen at: ${frozenAt}`,
        `parameters: s = ${FROM}, e = ${TO} (inclusive full days)`,
        `rows: ${f.rows.length}`,
        `result file: ${file}`,
        `result sha256: ${f.sha}`,
        `reproduce: pnpm thesis:data`,
      ],
      def.query,
    ),
  );
  const notes: string[] = [];
  if (def.id === "new_signers_daily")
    notes.push(`${FROM} (the window start) is left out by definition: every signer is new that day.`);
  if (["intents_volume_daily", "swaps_daily", "intents_mix_daily"].includes(def.id))
    notes.push("Partial swap days are excluded and listed as missing (see swaps_coverage).");
  return {
    id: def.id,
    title: def.title,
    unit: def.unit,
    file,
    sha256: f.sha,
    rows: f.rows.length,
    columns: def.columns,
    source: def.source,
    sqlExecuted: `sql/executed/${def.id}.sql`,
    sqlBigQuery: b ? b.sqlBigQuery : null,
    bigQueryExecuted: b ? b.executed : false,
    bigQueryBytesBilled: b && b.bytesBilled !== null ? String(b.bytesBilled) : null,
    definition: def.definition,
    caveats: [
      ...def.caveats,
      ...(b && !b.executed
        ? [
            `The BigQuery source query ${b.sqlBigQuery} is NOT EXECUTED in this build; the local series is used.`,
          ]
        : []),
    ],
    coverage: {
      missingDays: missing,
      note: notes.length
        ? notes.join(" ")
        : def.daily
          ? missing.length === 0
            ? `All ${f.rows.length} days of the window are present.`
            : null
          : null,
    },
  };
});

const manifest = {
  schema: "nearesis.thesis.raw.v1",
  kind: "forecast",
  frozenAt,
  methodFrozenAt,
  window: { from: FROM, to: TO },
  headThreshold: HEAD_THRESHOLD,
  stablecoinSet: STABLE,
  nearTokenSymbols: NEAR_TOKEN,
  internalChecks,
  crossChecks,
  bigQueryQueries: bqQueries,
  datasets,
};
writeFileSync(join(THESIS, "raw", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    frozenAt,
    methodFrozenAt,
    unchanged,
    window: manifest.window,
    internal: internalChecks.organicEqualsHeadPlusTail.daysEqual,
    crossChecks: crossChecks.map((c) => `${c.id}: ${c.daysEqual}/${c.daysCompared}`),
    bigQuery: bqQueries.map((q) => ({ id: q.id, executed: q.executed, bytesBilled: q.bytesBilled })),
    datasets: datasets.map((d) => ({ id: d.id, rows: d.rows, sha256: d.sha256.slice(0, 12) })),
  }),
);

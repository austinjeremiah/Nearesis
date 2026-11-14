import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEES_FROM,
  FEES_LAST,
  FEES_TO_EXCLUSIVE,
  TOP_EXECUTORS_PER_CHUNK,
  DAY_RANK_KEEP,
  blocksSql,
  discoverySql,
  outcomesSql,
  txSql,
} from "./fees-sql.ts";
import { KEEP_ACCOUNTS } from "./fees-footprint.ts";
import {
  buildIntents,
  buildTakeRate,
  buildTopReceivers,
  buildTotal,
  buildTxFees,
  collectBlocks,
  collectOutcomes,
  collectTx,
  crossCheck,
  daysBetween,
  deriveFootprint,
  headline,
  WIDE_MIN_DEPENDENCE,
  WIDE_MIN_SHARE,
  yoctoToNear,
  type CrossCheck,
  type DailyTotals,
  type HeadlinePeriod,
  type Table,
} from "./fees-series.ts";

/**
 * Derives the frozen raw fee series, the manifest, the SQL records and NOTES.md from the saved BigQuery chunk results
 * (thesis/raw/fees/chunks/*.json). No BigQuery access here; the local ClickHouse is only read for the cross-check.
 */
export interface JobRecord {
  id: string;
  family: string;
  from: string;
  to: string;
  sql: string;
  querySha256: string;
  dryRunBytes: number;
  bytesBilled: number;
  jobId: string | null;
  location: string;
  executedAt: string;
  rows: number;
  columns: string[];
  data: Array<Array<string | null>>;
  resultSha256: string;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const gib = (b: number): string => (b / 1024 ** 3).toFixed(3);
type Col = { name: string; type: string };

/** Same file shape as the other thesis raw files: {"columns":[...],"rows":[\n[...],\n...\n]}. */
export function rawFileText(columns: Col[], rows: Array<Array<string | null>>): string {
  return `{"columns":${JSON.stringify(columns)},"rows":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
}

const objRows = <T extends object>(rows: T[], cols: Array<[keyof T & string, string]>) =>
  rows.map((r) => cols.map(([k]) => ((r as Record<string, unknown>)[k] ?? null) as string | null));

const readFrozen = (path: string): { map: Map<string, string | null>; sha256: string } => {
  const text = readFileSync(path, "utf8");
  const j = JSON.parse(text) as { rows: Array<[string, string | null]> };
  return { map: new Map(j.rows.map((r) => [r[0], r[1]] as const)), sha256: sha(text) };
};

const CH_URL = process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123";
async function ch(query: string): Promise<Array<Record<string, string | null>>> {
  const u = new URL(CH_URL);
  u.searchParams.set("readonly", "2");
  u.searchParams.set("default_format", "JSONEachRow");
  for (const k of ["output_format_json_quote_64bit_integers", "output_format_json_quote_decimals"])
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
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 200)}`);
  return text.trim() === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, string | null>);
}

const dailyMap = (
  rows: Array<Record<string, string | null>>,
  a = "tokens",
  b = "gas",
): Map<string, DailyTotals> =>
  new Map(rows.map((r) => [String(r.d), { tokens: BigInt(r[a] ?? "0"), gas: BigInt(r[b] ?? "0") }] as const));

interface Check {
  name: string;
  localTable: string;
  result: CrossCheck;
}

async function crossChecks(
  total: Map<string, DailyTotals>,
  intentsNear: Map<string, DailyTotals>,
  conversion: Map<string, DailyTotals>,
  blocksSum: Map<string, DailyTotals>,
): Promise<Check[]> {
  const lo = FEES_FROM;
  const hi = FEES_LAST;
  const w = `block_date >= toDate('${lo}') AND block_date <= toDate('${hi}')`;
  const t1 = dailyMap(
    await ch(
      `SELECT block_date AS d, toString(sum(tokens_burnt_yocto)) AS tokens, toString(sum(gas_burnt)) AS gas FROM nearesis_live.near_economics_outcomes_daily FINAL WHERE ${w} GROUP BY d ORDER BY d`,
    ),
  );
  const t2 = dailyMap(
    await ch(
      `SELECT block_date AS d, toString(sum(tokens_burnt_yocto)) AS tokens, toString(sum(gas_burnt)) AS gas FROM nearesis_live.near_economics_outcomes_daily FINAL WHERE ${w} AND executor_account_id = 'intents.near' GROUP BY d ORDER BY d`,
    ),
  );
  const t3 = dailyMap(
    await ch(
      `SELECT block_date AS d, toString(sum(conversion_tokens_yocto)) AS tokens, toString(sum(conversion_gas)) AS gas FROM nearesis_live.near_economics_conversion_daily FINAL WHERE ${w} AND scope = 'day' GROUP BY d ORDER BY d`,
    ),
  );
  const t4 = dailyMap(
    await ch(
      `SELECT block_date AS d, toString(sum(sum_gas_price_yocto)) AS tokens, toString(sum(blocks)) AS gas FROM nearesis_live.near_economics_gas_price_daily FINAL WHERE ${w} GROUP BY d ORDER BY d`,
    ),
  );
  return [
    {
      name: "total tokens and gas per day (all executors)",
      localTable: "near_economics_outcomes_daily",
      result: crossCheck(total, t1),
    },
    {
      name: "executor intents.near only (tokens and gas)",
      localTable:
        "near_economics_outcomes_daily (rows of intents.near; accounts under 100 outcomes a day are folded there)",
      result: crossCheck(intentsNear, t2),
    },
    {
      name: "transaction conversion burn per day (tokens, gas)",
      localTable: "near_economics_conversion_daily (scope day)",
      result: crossCheck(conversion, t3),
    },
    {
      name: "blocks.gas_price sum (in the tokens column) and block count (in the gas column)",
      localTable: "near_economics_gas_price_daily",
      result: crossCheck(blocksSum, t4),
    },
  ];
}

function sqlHeader(lines: string[]): string {
  return lines.map((l) => `-- ${l}`).join("\n");
}

export interface BuildOptions {
  appRoot: string;
  /** Skip the local ClickHouse cross-check (tests). */
  skipCrossCheck?: boolean;
}

export async function buildAll(opts: BuildOptions): Promise<{ files: string[] }> {
  const feesDir = join(opts.appRoot, "thesis", "raw", "fees");
  const chunkDir = join(feesDir, "chunks");
  const sqlBq = join(opts.appRoot, "thesis", "sql", "bigquery");
  const sqlEx = join(opts.appRoot, "thesis", "sql", "executed");
  for (const d of [feesDir, sqlBq, sqlEx]) mkdirSync(d, { recursive: true });
  const recs: JobRecord[] = readdirSync(chunkDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(chunkDir, f), "utf8")) as JobRecord);
  const tab = (r: JobRecord): Table => ({ columns: r.columns, data: r.data });
  const fam = (f: string): JobRecord[] =>
    recs.filter((r) => r.family === f).sort((a, b) => (a.from < b.from ? -1 : 1));
  const outChunks = fam("outcomes");
  const discoveryRecs = fam("discovery");
  if (outChunks.length === 0)
    throw new Error("no outcomes chunks have run yet (pnpm thesis:fees run --execute)");
  if (discoveryRecs.length === 0)
    throw new Error("no discovery has run yet (pnpm thesis:fees discover --execute)");

  const outcomes = collectOutcomes(
    outChunks.map((r) => ({ id: r.id, from: r.from, to: r.to, table: tab(r) })),
  );
  const blocks = collectBlocks(fam("blocks").map(tab));
  const tx = collectTx(fam("tx").map(tab));
  const fp = deriveFootprint(
    discoveryRecs.map((r) => ({ day: r.from, table: tab(r) })),
    outcomes,
  );

  const total = buildTotal(outcomes, blocks);
  const intents = buildIntents(outcomes, fp);
  const intentsByDay = new Map(intents.map((i) => [i.d, i] as const));
  const top = buildTopReceivers(outcomes);
  const txFees = buildTxFees(tx, intentsByDay, fp);
  const price = readFrozen(join(opts.appRoot, "thesis", "raw", "near_price_daily.json"));
  const volume = readFrozen(join(opts.appRoot, "thesis", "raw", "intents_volume_daily.json"));
  const take = buildTakeRate(intents, price.map, volume.map);

  const allDays = daysBetween(FEES_FROM, FEES_LAST);
  const missing = (have: string[]): string[] => allDays.filter((d) => !have.includes(d));
  const billed = (rs: JobRecord[]): string => String(rs.reduce((s, r) => s + r.bytesBilled, 0));
  const totalBilled = recs.reduce((s, r) => s + r.bytesBilled, 0);
  const frozenAt = new Date().toISOString();
  const files: string[] = [];
  const manifest: Array<Record<string, unknown>> = [];

  const jobsOf = (rs: JobRecord[]) =>
    rs.map((r) => ({
      id: r.id,
      from: r.from,
      to: r.to,
      jobId: r.jobId,
      location: r.location,
      executedAt: r.executedAt,
      dryRunBytes: r.dryRunBytes,
      bytesBilled: r.bytesBilled,
      rows: r.rows,
      resultSha256: r.resultSha256,
      querySha256: r.querySha256,
    }));

  function emit(o: {
    id: string;
    title: string;
    unit: string;
    columns: Col[];
    rows: Array<Array<string | null>>;
    source: string;
    definition: string;
    caveats: string[];
    haveDays: string[] | null;
    jobs: JobRecord[];
    canonicalSql: string | null; // full-window SQL text for sql/bigquery (null: no BigQuery SQL)
    derivation?: string[]; // text lines for a derived (non-BigQuery) series
    coverageNote?: string;
  }): void {
    const text = rawFileText(o.columns, o.rows);
    const file = `raw/fees/${o.id}.json`;
    writeFileSync(join(opts.appRoot, "thesis", file), text);
    files.push(file);
    const sqlName = `fees_${o.id.replace(/^fees_/, "")}.sql`;
    const bqPath = o.canonicalSql ? `sql/bigquery/${sqlName}` : null;
    if (o.canonicalSql)
      writeFileSync(
        join(opts.appRoot, "thesis", bqPath as string),
        `${sqlHeader([
          `thesis BigQuery source query: ${o.id}`,
          `${o.title}`,
          `Source: bigquery-public-data.crypto_near_mainnet_us (day-partitioned on block_date; both bounds are DECLAREd literals, end_date is exclusive).`,
          `Window: block_date ${FEES_FROM} .. ${FEES_LAST} inclusive. It is executed in calendar-month chunks (halved when a month does not fit the remaining daily quota);`,
          `a chunk differs from this text only in its two DECLARE lines. Per-chunk job records are in sql/executed/${sqlName}.`,
          "Run: pnpm thesis:fees run --execute (dry run first, BudgetLedger fit, maximumBytesBilled = 1.1 x estimate).",
        ])}\n-- ---- query ----\n${o.canonicalSql}\n`,
      );
    const exec = o.jobs.length
      ? `${sqlHeader([
          `thesis dataset: ${o.id} (${o.title})`,
          `executed against: BigQuery public dataset crypto_near_mainnet_us, location ${o.jobs[0]?.location}, SELECT only`,
          `frozen at: ${frozenAt}`,
          `rows: ${o.rows.length}`,
          `result file: ${file}`,
          `result sha256: ${sha(text)}`,
          `bytes billed (sum of the jobs below): ${billed(o.jobs)}`,
          ...o.jobs.map(
            (r) =>
              `job ${r.id} ${r.from}..${r.to} jobId=${r.jobId} location=${r.location} executedAt=${r.executedAt} dryRunBytes=${r.dryRunBytes} bytesBilled=${r.bytesBilled} rows=${r.rows} resultSha256=${r.resultSha256} querySha256=${r.querySha256}`,
          ),
          "The executed SQL of the newest chunk follows; the other chunks differ only in the two DECLARE lines.",
        ])}\n${o.jobs[o.jobs.length - 1]?.sql}\n`
      : `${sqlHeader([
          `thesis dataset: ${o.id} (${o.title})`,
          "derived locally from frozen files (pure code, services/ingestion/src/thesis/fees-series.ts); no query was executed for this file",
          `frozen at: ${frozenAt}`,
          `rows: ${o.rows.length}`,
          `result file: ${file}`,
          `result sha256: ${sha(text)}`,
          ...(o.derivation ?? []),
        ])}\n`;
    writeFileSync(join(opts.appRoot, "thesis", `sql/executed/${sqlName}`), exec);
    const have = o.haveDays;
    const miss = have ? missing(have) : [];
    manifest.push({
      id: o.id,
      title: o.title,
      unit: o.unit,
      file,
      sha256: sha(text),
      rows: o.rows.length,
      columns: o.columns,
      source: o.source,
      sqlExecuted: `sql/executed/${sqlName}`,
      sqlBigQuery: bqPath,
      bigQueryExecuted: o.jobs.length > 0,
      bigQueryBytesBilled: o.jobs.length ? billed(o.jobs) : null,
      bigQueryJobs: jobsOf(o.jobs),
      definition: o.definition,
      caveats: o.caveats,
      coverage: {
        missingDays: miss,
        note:
          o.coverageNote ??
          (have
            ? miss.length === 0
              ? `All ${allDays.length} days of the window are present.`
              : `${miss.length} of ${allDays.length} days are not covered (deferred, never zero-filled).`
            : "Not a daily series."),
      },
    });
  }

  const BQ = "BigQuery public dataset bigquery-public-data.crypto_near_mainnet_us";
  const protocolNote =
    "Gross tokens_burnt of the outcomes. Whether part of a fee is burnt or paid to the called contract: nearcore docs state a 30% contract reward up to protocol version 86 and 0% from 87 (docs/economics/SEMANTICS.md); the mainnet activation date of version 87 is not verified here, so no burnt/paid split is applied.";
  const f64 =
    "tokens_burnt is FLOAT64 in the public dataset: each value above 2^53 yocto is already rounded at the source (relative error at most 2^-53); sums here are exact over the stored doubles.";
  const outDays = [...outcomes.days.keys()];
  const outJobs = outChunks;
  const outCanon = outcomesSql({ from: FEES_FROM, to: FEES_TO_EXCLUSIVE }, KEEP_ACCOUNTS);

  emit({
    id: "fees_total_daily",
    title: "NEAR network fees burnt per day (all execution outcomes), gas and gas price",
    unit: "yoctoNEAR / NEAR / gas units",
    columns: [
      { name: "d", type: "date" },
      { name: "outcomes", type: "integer-string" },
      { name: "gas_burnt", type: "integer-string" },
      { name: "tokens_burnt_yocto", type: "integer-string" },
      { name: "tokens_burnt_near", type: "decimal-string" },
      { name: "blocks", type: "integer-string|null" },
      { name: "avg_gas_price_yocto", type: "decimal-string|null" },
      { name: "min_gas_price_yocto", type: "integer-string|null" },
      { name: "max_gas_price_yocto", type: "integer-string|null" },
      { name: "null_gas_rows", type: "integer-string" },
      { name: "null_token_rows", type: "integer-string" },
    ],
    rows: objRows(total, [
      ["d", ""],
      ["outcomes", ""],
      ["gas_burnt", ""],
      ["tokens_burnt_yocto", ""],
      ["tokens_burnt_near", ""],
      ["blocks", ""],
      ["avg_gas_price_yocto", ""],
      ["min_gas_price_yocto", ""],
      ["max_gas_price_yocto", ""],
      ["null_gas_rows", ""],
      ["null_token_rows", ""],
    ]),
    source: `${BQ}.execution_outcomes (block_date, executor_account_id, gas_burnt, tokens_burnt) and .blocks (gas_price)`,
    definition: `Per UTC block day: the sum of tokens_burnt (yoctoNEAR, and the same in NEAR = yocto / 10^24) and gas_burnt over every row of execution_outcomes (transaction outcomes and receipt outcomes, incl. refund receipts that burn no tokens), the outcome count, and the day's mean gas price = sum of blocks.gas_price / block count. ${protocolNote}`,
    caveats: [
      f64,
      "Days are the execution day (block_date of the outcome), not the transaction day.",
      "Gas is the gas UNITS reported by outcomes (refund receipts report gas but burn no tokens); do not price it.",
      "tokens_burnt is not always gas_burnt x block gas price (dataset documentation), so the mean gas price is context, not a derivation.",
      "avg_gas_price_yocto is null on a day whose blocks chunk has not run.",
      ...(missing(outDays).length
        ? [`Days not yet fetched are missing, not zero: ${missing(outDays).length} days.`]
        : []),
    ],
    haveDays: outDays,
    jobs: [...outJobs, ...fam("blocks")],
    canonicalSql: `${outCanon}\n-- ---- blocks (separate job) ----\n${blocksSql({ from: FEES_FROM, to: FEES_TO_EXCLUSIVE })}`,
  });

  emit({
    id: "fees_intents_daily",
    title: "NEAR burnt by outcomes executed on NEAR Intents contracts, per day (narrow and wide sets)",
    unit: "yoctoNEAR / NEAR / gas units",
    columns: [
      { name: "d", type: "date" },
      ...["narrow_outcomes", "narrow_gas_burnt", "narrow_tokens_burnt_yocto"].map((n) => ({
        name: n,
        type: "integer-string",
      })),
      { name: "narrow_tokens_burnt_near", type: "decimal-string" },
      ...["wide_outcomes", "wide_gas_burnt", "wide_tokens_burnt_yocto"].map((n) => ({
        name: n,
        type: "integer-string",
      })),
      { name: "wide_tokens_burnt_near", type: "decimal-string" },
      { name: "wide_accounts_without_row", type: "integer-string" },
      { name: "total_tokens_burnt_yocto", type: "integer-string" },
      { name: "narrow_share_of_total_pct", type: "decimal-string|null" },
      { name: "wide_share_of_total_pct", type: "decimal-string|null" },
    ],
    rows: objRows(intents, [
      ["d", ""],
      ["narrow_outcomes", ""],
      ["narrow_gas_burnt", ""],
      ["narrow_tokens_burnt_yocto", ""],
      ["narrow_tokens_burnt_near", ""],
      ["wide_outcomes", ""],
      ["wide_gas_burnt", ""],
      ["wide_tokens_burnt_yocto", ""],
      ["wide_tokens_burnt_near", ""],
      ["wide_accounts_without_row", ""],
      ["total_tokens_burnt_yocto", ""],
      ["narrow_share_of_total_pct", ""],
      ["wide_share_of_total_pct", ""],
    ]),
    source: `${BQ}.execution_outcomes, with the contract sets discovered from execution_outcomes x receipt_origin_transaction x transactions (fees_footprint_discovery)`,
    definition: `Gross tokens_burnt and gas_burnt of execution outcomes whose executor_account_id is in the narrow set (core Intents contracts: ${fp.core.join(", ")}) or the wide set (core plus the settlement footprint: ${fp.wide.join(", ")}). The wide set rule: an account discovered among the executors of receipts originating from transactions sent to intents.near, carrying at least ${WIDE_MIN_SHARE * 100}% of that Intents-origin burn and getting at least ${WIDE_MIN_DEPENDENCE * 100}% of its own burn from it. ${protocolNote}`,
    caveats: [
      f64,
      "Executor attribution counts ALL burn executed on the account, whoever called it. For the core contracts that is Intents usage; for settlement-footprint accounts the dependence threshold keeps out generic contracts, but the wide figure can still include some non-Intents calls to those accounts.",
      "The transaction-to-receipt conversion burn of a transaction sent to intents.near is charged at the transaction outcome (executor = the signer), so it is NOT in this series; see tx_fee_intents_daily (narrow_direct_toll_yocto adds it).",
      "Wide accounts are kept individually only when they rank in the day's top " +
        DAY_RANK_KEEP +
        " executors by tokens (or are core / bridge constants); wide_accounts_without_row counts the wide accounts below that cut on the day (their burn is not in the sum, never zero-asserted).",
      "Private/shielded Intents settlement (after 2026-10-27) is not observable on chain and is not assumed zero.",
      "Footprint is discovered on three post-April sample days (2026-05-13, 2026-08-12, 2026-10-14); it was not validated on the higher-volume Nov 2025 to March 2026 regime.",
      ...(missing(outDays).length
        ? [`Days not yet fetched are missing, not zero: ${missing(outDays).length} days.`]
        : []),
    ],
    haveDays: outDays,
    jobs: [...outJobs, ...discoveryRecs],
    canonicalSql: `${outCanon}`,
  });

  emit({
    id: "fees_by_receiver_top",
    title: "Top 50 accounts by NEAR burnt, whole window and per quarter",
    unit: "yoctoNEAR / NEAR / percent",
    columns: [
      { name: "scope", type: "string" },
      { name: "rank", type: "integer" },
      { name: "account", type: "string" },
      { name: "outcomes", type: "integer-string" },
      { name: "gas_burnt", type: "integer-string" },
      { name: "tokens_burnt_yocto", type: "integer-string" },
      { name: "tokens_burnt_near", type: "decimal-string" },
      { name: "share_of_total_pct", type: "decimal-string|null" },
      { name: "chunks_present", type: "integer-string" },
      { name: "chunks_total", type: "integer-string" },
      { name: "lower_bound_only", type: "boolean" },
    ],
    rows: top.map((r) => [
      r.scope,
      String(r.rank),
      r.account,
      r.outcomes,
      r.gas_burnt,
      r.tokens_burnt_yocto,
      r.tokens_burnt_near,
      r.share_of_total_pct,
      r.chunks_present,
      r.chunks_total,
      r.lower_bound_only ? "true" : "false",
    ]),
    source: `${BQ}.execution_outcomes (per-chunk top ${TOP_EXECUTORS_PER_CHUNK} executors by tokens)`,
    definition: `For scope "window" and each calendar quarter present: accounts ranked by the sum of tokens_burnt over the outcomes they executed (executor_account_id: a contract for receipt outcomes, the signer for transaction outcomes, so a user or bot account appears for the conversion burn of its own transactions). share_of_total_pct = account tokens / all tokens burnt on the covered days of the scope. Quarters: Q4 2025 starts 2025-11-10, Q4 2026 ends 2026-11-13. ${protocolNote}`,
    caveats: [
      f64,
      `Built from the top ${TOP_EXECUTORS_PER_CHUNK} executors of each chunk (month or half month). An account missing from a chunk's list burnt less than that chunk's smallest listed value there, so rows with lower_bound_only = true are lower bounds; false means the account is in every chunk list and its total is exact.`,
      "Accounts are executors, not payers: the NEAR for a receipt is bought by the transaction signer; attribution to the executing contract is where the gas was burnt.",
      ...(outChunks.length < 13
        ? [`Only ${outChunks.length} outcome chunk(s) have run; scopes cover those chunks only.`]
        : []),
    ],
    haveDays: null,
    jobs: outJobs,
    canonicalSql: outCanon,
    coverageNote: `Covers the ${outChunks.length} outcome chunk(s) fetched (${outChunks.map((c) => c.from).join(", ")}).`,
  });

  const txDays = [...tx.days.keys()];
  emit({
    id: "tx_fee_intents_daily",
    title:
      "Transactions sent to NEAR Intents contracts per day with their conversion fee, reconciled to the outcome series",
    unit: "transactions / yoctoNEAR / NEAR / gas units",
    columns: [
      { name: "d", type: "date" },
      { name: "txs_total", type: "integer-string" },
      { name: "conversion_tokens_total_yocto", type: "integer-string" },
      { name: "narrow_txs", type: "integer-string" },
      { name: "narrow_conversion_gas", type: "integer-string" },
      { name: "narrow_conversion_tokens_yocto", type: "integer-string" },
      { name: "narrow_conversion_tokens_near", type: "decimal-string" },
      { name: "wide_txs", type: "integer-string" },
      { name: "wide_conversion_gas", type: "integer-string" },
      { name: "wide_conversion_tokens_yocto", type: "integer-string" },
      { name: "wide_conversion_tokens_near", type: "decimal-string" },
      { name: "narrow_receipt_outcomes", type: "integer-string|null" },
      { name: "narrow_outcomes_per_tx", type: "decimal-string|null" },
      { name: "narrow_executor_tokens_yocto", type: "integer-string|null" },
      { name: "narrow_direct_toll_yocto", type: "integer-string|null" },
      { name: "narrow_conversion_share_of_direct_pct", type: "decimal-string|null" },
    ],
    rows: objRows(txFees, [
      ["d", ""],
      ["txs_total", ""],
      ["conversion_tokens_total_yocto", ""],
      ["narrow_txs", ""],
      ["narrow_conversion_gas", ""],
      ["narrow_conversion_tokens_yocto", ""],
      ["narrow_conversion_tokens_near", ""],
      ["wide_txs", ""],
      ["wide_conversion_gas", ""],
      ["wide_conversion_tokens_yocto", ""],
      ["wide_conversion_tokens_near", ""],
      ["narrow_receipt_outcomes", ""],
      ["narrow_outcomes_per_tx", ""],
      ["narrow_executor_tokens_yocto", ""],
      ["narrow_direct_toll_yocto", ""],
      ["narrow_conversion_share_of_direct_pct", ""],
    ]),
    source: `${BQ}.transactions (receiver_account_id, receipt_conversion_gas_burnt, receipt_conversion_tokens_burnt), reconciled with fees_intents_daily`,
    definition: `Transactions per UTC day whose receiver is a narrow (${fp.core.join(", ")}) or wide (${fp.wide.join(", ")}) account, with the transaction-level fee the dataset carries: receipt_conversion_* = gas and tokens burnt converting the signed transaction into its first receipt (transaction day). Reconciliation to fees_intents_daily on days where both exist: narrow_outcomes_per_tx = receipt outcomes executed on the narrow contracts / transactions sent to them; narrow_direct_toll = executor tokens of the narrow contracts + conversion tokens of transactions sent to them.`,
    caveats: [
      f64,
      "This is not the full transaction cost: the dataset's transaction row carries only the conversion burn; the cost of the receipts is the executor series.",
      "The two series measure different, additive parts of the toll. Conversion burn sits at the transaction outcome (executor = signer) and is absent from fees_intents_daily; the executor series counts every receipt executed on the contract, including receipts from transactions sent elsewhere, callbacks and retries, so outcomes per transaction is not exactly 1.",
      "Transactions that fail before any receipt executes, and receipts delayed past midnight, shift counts between neighbouring days.",
      "Wide receivers are kept per day only when they rank in the day's top 300 receivers by transactions (or are core / bridge constants).",
      ...(missing(txDays).length
        ? [`Days not yet fetched are missing, not zero: ${missing(txDays).length} days.`]
        : []),
    ],
    haveDays: txDays,
    jobs: fam("tx"),
    canonicalSql: txSql({ from: FEES_FROM, to: FEES_TO_EXCLUSIVE }, KEEP_ACCOUNTS),
  });

  emit({
    id: "fees_take_rate_gas_daily",
    title:
      "Gas take rate of NEAR Intents: NEAR burnt on Intents contracts, in basis points of settled USD value",
    unit: "basis points (USD burn / USD volume x 10^4)",
    columns: [
      { name: "d", type: "date" },
      ...["price_usd", "volume_usd", "narrow_burn_usd", "wide_burn_usd"].map((n) => ({
        name: n,
        type: "decimal-string|null",
      })),
      ...[
        "take_rate_gas_bps_narrow",
        "take_rate_gas_bps_wide",
        "take_rate_gas_bps_narrow_30d",
        "take_rate_gas_bps_wide_30d",
      ].map((n) => ({ name: n, type: "decimal-string|null" })),
      { name: "days_in_30d", type: "integer-string" },
      { name: "intents_share_of_burn_pct_narrow", type: "decimal-string|null" },
      { name: "intents_share_of_burn_pct_wide", type: "decimal-string|null" },
    ],
    rows: objRows(take, [
      ["d", ""],
      ["price_usd", ""],
      ["volume_usd", ""],
      ["narrow_burn_usd", ""],
      ["wide_burn_usd", ""],
      ["take_rate_gas_bps_narrow", ""],
      ["take_rate_gas_bps_wide", ""],
      ["take_rate_gas_bps_narrow_30d", ""],
      ["take_rate_gas_bps_wide_30d", ""],
      ["days_in_30d", ""],
      ["intents_share_of_burn_pct_narrow", ""],
      ["intents_share_of_burn_pct_wide", ""],
    ]),
    source: `derived from raw/fees/fees_intents_daily.json, raw/near_price_daily.json (sha256 ${price.sha256}) and raw/intents_volume_daily.json (sha256 ${volume.sha256})`,
    definition:
      "take_rate_gas_bps = (NEAR burnt by the Intents contracts that day x that day's NEAR/USD close) / (that day's Intents successful known-USD volume) x 10^4, in basis points of settled value, for the narrow and the wide set. The 30 day figure is the ratio of sums over the trailing 30 calendar days (days with burn, price and volume all present; null below 15 such days). intents_share_of_burn_pct = Intents burn / all NEAR burnt that day. This is the gas/burn toll only: protocol-level burn of outcomes executed on the Intents contracts. Not verified here: which share of a fee is burnt versus paid to the called contract under current protocol rules (documented 30% to the contract up to protocol version 86, 0% from 87, activation date unverified).",
    caveats: [
      "Gas burn is one toll component only: it excludes the conversion burn charged to the signer, other contracts' burn, solver/relayer fees and any Intents protocol fee.",
      "USD value of the burn uses the daily close, not an intraday price; volume is the provider's USD value of successful swaps at swap time and is partial for the days listed missing in intents_volume_daily (those days are null here, never zero).",
      "Intents volume covers 1Click swaps the Explorer exposes; after 2026-10-27 private settlement is not observed, so a lower volume there means unobserved.",
      "Days where either the burn row, the price or the volume is absent have null rates.",
    ],
    haveDays: intents.map((i) => i.d),
    jobs: [],
    canonicalSql: null,
    derivation: [
      "take_rate_gas_bps = burn_yocto / 10^24 x price_usd / volume_usd x 10^4 (exact integer arithmetic, 8 decimals, half-even)",
      "30 day = sum(burn USD) / sum(volume USD) over the trailing 30 calendar days on usable days (>= 15)",
    ],
  });

  // ---- discovery file -------------------------------------------------------------------------------------------------
  const discRows = fp.rows.map((r) => [
    r.account,
    r.intentsTokens.toString(),
    yoctoToNear(r.intentsTokens),
    r.shareOfIntentsOrigin,
    r.ownTokens === null ? null : r.ownTokens.toString(),
    r.dependencePct,
    r.inCore ? "true" : "false",
    r.inWide ? "true" : "false",
    r.reason,
  ]);
  emit({
    id: "fees_footprint_discovery",
    title:
      "NEAR Intents footprint discovery: executors of receipts originating from transactions sent to intents.near",
    unit: "yoctoNEAR / percent",
    columns: [
      { name: "account", type: "string" },
      { name: "intents_origin_tokens_yocto", type: "integer-string" },
      { name: "intents_origin_tokens_near", type: "decimal-string" },
      { name: "share_of_intents_origin_pct", type: "decimal-string" },
      { name: "own_tokens_same_days_yocto", type: "integer-string|null" },
      { name: "dependence_pct", type: "decimal-string|null" },
      { name: "in_narrow_set", type: "boolean" },
      { name: "in_wide_set", type: "boolean" },
      { name: "reason", type: "string" },
    ],
    rows: discRows,
    source: `${BQ}: execution_outcomes x receipt_origin_transaction x transactions on ${fp.sampleDays.join(", ")}`,
    definition: `Top 40 executor accounts by tokens burnt per sample day among receipt outcomes belonging to transactions whose receiver is intents.near (same-day receipts), summed over the sample days. Intents-origin total over all executors: ${fp.originTotalTokens} yocto (the top-40 sum is ${fp.top40Tokens} yocto). dependence_pct = the account's Intents-origin burn / its own total burn on the same days. Core set: ${fp.core.join(", ")}. Wide set: ${fp.wide.join(", ")}.`,
    caveats: [
      "Receipts executing after the day of their transaction are not seen; transaction outcomes (executor = signer) are not receipts and are not in this join.",
      "Three sample days only (post-2026-04-02 regime).",
      f64,
    ],
    haveDays: null,
    jobs: discoveryRecs,
    canonicalSql: discoverySql(fp.sampleDays[0] ?? "2026-05-13"),
    coverageNote: `Sample days ${fp.sampleDays.join(", ")}.`,
  });

  // ---- cross-check ------------------------------------------------------------------------------------------------------
  let checks: Check[] = [];
  if (!opts.skipCrossCheck) {
    const mine = new Map<string, DailyTotals>(
      [...outcomes.days.values()].map((d) => [d.date, { tokens: d.tokens, gas: d.gas }] as const),
    );
    const intentsNear = new Map<string, DailyTotals>();
    for (const [d, m] of outcomes.ex) {
      const r = m.get("intents.near");
      if (r) intentsNear.set(d, { tokens: r.tokens, gas: r.gas });
    }
    const conv = new Map(
      [...tx.days.values()].map((d) => [d.date, { tokens: d.tokens, gas: d.gas }] as const),
    );
    const bsum = new Map(
      [...blocks.values()].map((b) => [b.date, { tokens: b.sum, gas: b.blocks }] as const),
    );
    checks = await crossChecks(mine, intentsNear, conv, bsum);
    writeFileSync(
      join(feesDir, "crosscheck.json"),
      `${JSON.stringify({ generatedAt: frozenAt, checks }, null, 1)}\n`,
    );
    files.push("raw/fees/crosscheck.json");
  }

  // ---- manifest -------------------------------------------------------------------------------------------------------------
  const manifestText = `${JSON.stringify({ schema: "nearesis.thesis.raw.v1", frozenAt, window: { from: FEES_FROM, to: FEES_LAST }, datasets: manifest }, null, 2)}\n`;
  writeFileSync(join(feesDir, "manifest.json"), manifestText);
  files.push("raw/fees/manifest.json");

  // ---- NOTES.md ------------------------------------------------------------------------------------------------------------
  const first = headline(total, intents, price.map, volume.map, "first");
  const last = headline(total, intents, price.map, volume.map, "last");
  writeFileSync(
    join(feesDir, "NOTES.md"),
    notes({
      fp,
      first,
      last,
      checks,
      recs,
      totalBilled,
      outDays,
      txDays,
      missingOut: missing(outDays),
      missingTx: missing(txDays),
      take,
      topCut: DAY_RANK_KEEP,
      allDays: allDays.length,
    }),
  );
  files.push("raw/fees/NOTES.md");
  return { files };
}

function notes(a: {
  fp: ReturnType<typeof deriveFootprint>;
  first: HeadlinePeriod;
  last: HeadlinePeriod;
  checks: Check[];
  recs: JobRecord[];
  totalBilled: number;
  outDays: string[];
  txDays: string[];
  missingOut: string[];
  missingTx: string[];
  take: ReturnType<typeof buildTakeRate>;
  topCut: number;
  allDays: number;
}): string {
  const H = (p: HeadlinePeriod): string =>
    `| ${p.from} to ${p.to} | ${p.totalBurnNearPerDay} NEAR / ${p.totalBurnUsdPerDay} USD | ${p.intentsNarrowNearPerDay} / ${p.intentsWideNearPerDay} NEAR | ${p.narrowSharePct}% / ${p.wideSharePct}% | ${p.takeRateBpsNarrow ?? "n/a"} / ${p.takeRateBpsWide ?? "n/a"} bps (${p.takeRateDays} days) |`;
  const byFam = new Map<string, number>();
  for (const r of a.recs) byFam.set(r.family, (byFam.get(r.family) ?? 0) + r.bytesBilled);
  const ranges = (days: string[]): string => (days.length ? `${days.length} days` : "none");
  return `# NEAR fee and burn data for "The Toll Booth Problem"

Generated by \`pnpm thesis:fees build\` from the saved BigQuery job results. All amounts are exact decimal strings (yoctoNEAR = 10^-24 NEAR). Window ${FEES_FROM} to ${FEES_LAST}.

## Definitions

- **Fee burnt** = \`tokens_burnt\` of BigQuery \`execution_outcomes\` rows (gross, per outcome). Burnt vs paid-to-contract: not verified here. nearcore documents a 30% reward to the called contract up to protocol version 86 and 0% from 87 (docs/economics/SEMANTICS.md); the version 87 mainnet activation date is unverified, so no split is applied and all figures are gross \`tokens_burnt\`.
- **Narrow set** (core Intents contracts): ${a.fp.core.join(", ")}. **Wide set** (core + settlement footprint): ${a.fp.wide.join(", ")}.
- **Difference narrow vs wide**: the wide set adds ${a.fp.wide.filter((x) => !a.fp.core.includes(x)).join(", ") || "nothing"}; those are bridge / token contracts that execute receipts as part of Intents settlement and that get at least ${WIDE_MIN_DEPENDENCE * 100}% of their own burn from Intents-origin receipts. Wide counts all burn on those accounts, not only Intents calls.
- **take_rate_gas** = (NEAR burnt by Intents contracts x day close) / (successful known-USD Intents volume) in basis points. It is the gas/burn toll only.

## Footprint discovery

Sample days ${a.fp.sampleDays.join(", ")}. Receipt outcomes that belong to transactions sent to intents.near (receipt_origin_transaction join, same day). Total Intents-origin burn over all executors ${yoctoToNear(a.fp.originTotalTokens)} NEAR, top 40 per day cover ${yoctoToNear(a.fp.top40Tokens)} NEAR.

| account | Intents-origin NEAR | share | own burn same days (NEAR) | dependence | set |
| --- | --- | --- | --- | --- | --- |
${a.fp.rows.map((r) => `| ${r.account} | ${yoctoToNear(r.intentsTokens)} | ${r.shareOfIntentsOrigin}% | ${r.ownTokens === null ? "unknown" : yoctoToNear(r.ownTokens)} | ${r.dependencePct ?? "n/a"}${r.dependencePct ? "%" : ""} | ${r.inCore ? "narrow+wide" : r.inWide ? "wide" : "excluded: " + r.reason} |`).join("\n")}

## What is and is not captured

- Captured: gross tokens burnt and gas of every execution outcome (${ranges(a.outDays)} of ${a.allDays}); transaction conversion burn for ${ranges(a.txDays)}.
- Not captured: the conversion burn is NOT in the executor series (it is charged at the transaction outcome, executor = signer); see tx_fee_intents_daily. Private/shielded Intents settlement after 2026-10-27 is not observable. Receipts of Intents transactions that execute on other contracts are only in the wide set when the account passed the footprint rule. Wide accounts below the day's top ${a.topCut} executors are not in the wide sum (counted in wide_accounts_without_row).
- tokens_burnt is FLOAT64 at the source; values above 2^53 yocto are already rounded there.
- Missing days (not fetched): outcomes ${a.missingOut.length}${a.missingOut.length ? ` (${a.missingOut[0]} .. ${a.missingOut[a.missingOut.length - 1]})` : ""}, transactions ${a.missingTx.length}.

## Cross-check against the local near_economics tables

${a.checks.length ? a.checks.map((c) => `- ${c.name} vs ${c.localTable}: ${c.result.matchingDays} matching days, identical on ${c.result.tokens.identicalDays} (tokens/sum) and ${c.result.gas.identicalDays} (gas/count); max abs diff tokens ${c.result.tokens.maxAbsDiffYocto}${c.result.tokens.maxAbsDiffDay ? ` on ${c.result.tokens.maxAbsDiffDay}` : ""}, max relative ${c.result.tokens.maxRelDiff ?? "n/a"}; gas max abs ${c.result.gas.maxAbsDiff}, max relative ${c.result.gas.maxRelDiff ?? "n/a"}; days only in mine ${c.result.onlyMineDays}, only in theirs ${c.result.onlyTheirsDays}.`).join("\n") : "Not run in this build."}

Full detail: crosscheck.json. A non-zero difference is a finding to explain, not to smooth.

## Bytes billed

Total ${gib(a.totalBilled)} GiB (${a.totalBilled} bytes) over ${a.recs.length} jobs: ${[...byFam.entries()].map(([f, b]) => `${f} ${gib(b)} GiB`).join(", ")}.

## Headline numbers (first 30 days vs last 30 days)

| period | total burn per day | Intents burn per day (narrow / wide) | Intents share of burn (narrow / wide) | take rate (narrow / wide) |
| --- | --- | --- | --- | --- |
${H(a.first)}
${H(a.last)}

USD uses each day's own NEAR/USD close. Take rate is the ratio of summed burn USD to summed volume USD on days where burn, price and volume all exist.
`;
}

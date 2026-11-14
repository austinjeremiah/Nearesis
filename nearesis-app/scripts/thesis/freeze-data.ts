import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  compareIntSeries,
  missingDays,
  serializeRaw,
  sha256Hex,
  toPlainDecimal,
  topOverlap,
  withHeader,
  type RawColumn,
} from "./data-lib.ts";

/**
 * pnpm thesis:data [--bigquery]
 * Re-freezes thesis/raw from the local ClickHouse database `nearesis_live` (SELECT only, read-only session). Deterministic:
 * identical data gives identical files, hashes and manifest (frozenAt is kept when nothing changed). `--bigquery` ALSO runs
 * the billed BigQuery queries (dry run first, see services/ingestion/src/thesis/bq-run-cli.ts); without it the existing
 * BigQuery result files are only read, so a plain re-freeze costs nothing.
 */
const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const THESIS = join(APP, "thesis");
const FROM = "2026-05-05"; // v3 research window (same period as the frozen research results)
const TO = "2026-11-11";
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

const SWAPS_WHERE = "WHERE created_day BETWEEN {s:Date} AND {e:Date}";
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
  bq: string | null; // BigQuery source query id
  floatCols?: string[];
}
const DEFS: Def[] = [
  {
    id: "intents_volume_daily",
    title: "NEAR Intents swap volume per day (USD)",
    unit: "USD",
    source: "Intents Explorer API (ingested into ClickHouse nearesis_live.intents_swaps)",
    query: `SELECT created_day AS d,
  if(countIf(status = 'SUCCESS' AND amount_in_usd IS NULL) > 0, NULL, toFloat64(sumIf(amount_in_usd, amount_in_usd IS NOT NULL AND status = 'SUCCESS'))) AS value
FROM nearesis_live.intents_swaps FINAL
${SWAPS_WHERE}
GROUP BY d ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "decimal-string|null" },
    ],
    numeric: ["value"],
    floatCols: ["value"],
    definition:
      "Sum of amount_in_usd over swaps with status SUCCESS, by created_day (UTC), NULL USD amounts excluded; same definition as the frozen v3 research snapshot (a day with a SUCCESS swap whose USD is NULL would be null, none are in this window).",
    caveats: [
      "Volume counts SUCCESS swaps only. REFUNDED and FAILED swaps are excluded, which also excludes the four refunded swaps whose provider USD values are absurd (quarantined in usd-quarantine.ts).",
      "Values are sums computed as Float64 by the research definition (toFloat64); each is printed as the shortest round-trip decimal and is exact only as printed, not as an exact decimal sum.",
      "amount_in_usd is the provider's USD value of the input amount at swap time, not an audited price.",
      "1Click swaps are not all NEAR Intents activity, and the Explorer shows only swaps it exposes; after 2026-10-27 private (shielded) settlement is not observed, so lower later values mean unobserved, not zero.",
    ],
    bq: null,
  },
  {
    id: "intents_swaps_daily",
    title: "NEAR Intents swaps per day (count)",
    unit: "swaps",
    source: "Intents Explorer API (ingested into ClickHouse nearesis_live.intents_swaps)",
    query: `SELECT created_day AS d, countIf(status = 'SUCCESS') AS value, count() AS n_all
FROM nearesis_live.intents_swaps FINAL
${SWAPS_WHERE}
GROUP BY d ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "integer-string" },
      { name: "n_all", type: "integer-string" },
    ],
    numeric: ["value", "n_all"],
    definition:
      "value = swaps with status SUCCESS per created_day (UTC); n_all = swaps of every status that day.",
    caveats: [
      "2026-07-23 is marked partial in source_coverage (intents_swaps): the Explorer fetch for that day was incomplete, so its count is a lower bound. This is why the frozen v3 research status is INSUFFICIENT_DATA.",
      "1Click swaps are not all NEAR Intents activity; after 2026-10-27 private settlement is unobserved, not zero.",
    ],
    bq: null,
  },
  {
    id: "active_accounts_daily",
    title: "Daily active accounts (distinct signers)",
    unit: "accounts",
    source:
      "BigQuery public dataset crypto_near_mainnet_us.transactions (ingested into ClickHouse nearesis_live.account_daily_activity)",
    query: `SELECT block_date AS d, signers_total AS value, signers_organic
FROM nearesis_live.account_daily_activity FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "integer-string" },
      { name: "signers_organic", type: "integer-string" },
    ],
    numeric: ["value", "signers_organic"],
    definition:
      "value = COUNT(DISTINCT signer_account_id) over the day's transactions; signers_organic = the same after excluding transactions addressed to the Intents verifier and bridge contracts (documented rule in account-sql.ts).",
    caveats: [
      "Distinct signers are a proxy for active accounts, not people, and are not summable across days (an account active on two days counts twice).",
    ],
    bq: "active_accounts_daily",
  },
  {
    id: "transactions_daily",
    title: "NEAR transactions per day",
    unit: "transactions",
    source:
      "BigQuery public dataset crypto_near_mainnet_us.transactions (ingested into ClickHouse nearesis_live.near_daily_tx)",
    query: `SELECT block_date AS d, tx_count AS value
FROM nearesis_live.near_daily_tx FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "integer-string" },
    ],
    numeric: ["value"],
    definition:
      "Every row of the transactions table for the block_date. Successful and failed transactions cannot be told apart (the status column only carries SUCCESS_RECEIPT_ID).",
    caveats: [
      "Transactions include automated and Intents-generated activity; the count is not a measure of distinct users.",
    ],
    bq: "transactions_daily",
  },
  {
    id: "contract_usage_daily",
    title: "Contract usage per day (function calls and active contracts)",
    unit: "function-call actions",
    source:
      "BigQuery public dataset crypto_near_mainnet_us.receipt_actions (ingested into ClickHouse nearesis_live.contract_interactions and the near_daily_usage view)",
    query: `SELECT block_date AS d, function_call_actions AS value, active_contract_count AS active_contracts
FROM nearesis_live.near_daily_usage
WHERE block_date BETWEEN {s:Date} AND {e:Date}
ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "integer-string" },
      { name: "active_contracts", type: "integer-string" },
    ],
    numeric: ["value", "active_contracts"],
    definition:
      "value = FUNCTION_CALL actions per day; active_contracts = distinct receiver accounts of those actions. Receivers with >= 100 calls that day are held individually; the rest are folded into an exact per-day remainder, so both daily totals are exact.",
    caveats: [
      "contract_interactions only holds receivers with >= 100 calls on a day; the per-receiver detail (and contract_usage_top) therefore omits the long tail, while the daily totals include it.",
      "The BigQuery source queries (sql/bigquery) count transactions by receiver_account_id, a cheaper and different measure than function-call actions; the comparison is reported but is not like-for-like.",
    ],
    bq: "contract_usage_daily",
  },
  {
    id: "contract_usage_top",
    title: "Top 50 receiver contracts over the window (function calls)",
    unit: "function-call actions",
    source:
      "BigQuery public dataset crypto_near_mainnet_us.receipt_actions (ingested into ClickHouse nearesis_live.contract_interactions)",
    query: `SELECT receiver_account_id, sum(interactions) AS value, count() AS days_listed
FROM nearesis_live.contract_interactions FINAL
WHERE block_date BETWEEN {s:Date} AND {e:Date}
GROUP BY receiver_account_id
ORDER BY sum(interactions) DESC, receiver_account_id
LIMIT 50`,
    columns: [
      { name: "receiver_account_id", type: "string" },
      { name: "value", type: "integer-string" },
      { name: "days_listed", type: "integer-string" },
    ],
    numeric: ["value", "days_listed"],
    definition:
      "Receivers ranked by FUNCTION_CALL actions summed over the window, counting only the days a receiver had >= 100 calls; days_listed is the number of such days.",
    caveats: [
      "Only receiver-days with >= 100 calls are held, so totals understate receivers that were active below the threshold on some days.",
      "A ranking over the whole window has no per-day axis (no date column, no missing days).",
    ],
    bq: "contract_usage_top",
  },
  {
    id: "near_price_daily",
    title: "NEAR price per day (USD)",
    unit: "USD per NEAR",
    source: "Price provider (CoinGecko free plan, ingested into ClickHouse nearesis_live.price_candles)",
    query: `SELECT day AS d, argMax(close_raw, bucket_start) AS value
FROM nearesis_live.price_candles FINAL
WHERE day BETWEEN {s:Date} AND {e:Date} AND \`interval\` = '1d' AND symbol = 'NEAR' AND quote_currency = 'usd'
GROUP BY d ORDER BY d`,
    columns: [
      { name: "d", type: "date" },
      { name: "value", type: "decimal-string|null" },
    ],
    numeric: ["value"],
    definition:
      "The provider's last price sample of the UTC day (close_raw as received, exact string). The free plan has no daily OHLC history, so the day's candle is built from 24 hourly samples (basis hourly_samples_24_per_day).",
    caveats: [
      "The 'close' is the last hourly sample of the day, not an official daily close; the frozen research used the same value converted with toFloat64.",
      "Price is an aggregated provider quote, not a trade-weighted VWAP.",
    ],
    bq: null,
  },
];

const readJson = <T>(p: string): T | null =>
  existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : null;
const prevManifest = readJson<{ frozenAt: string; datasets: Array<{ id: string; sha256: string | null }> }>(
  join(THESIS, "raw", "manifest.json"),
);

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
const bqRaw = (id: string): BqRaw | null => readJson<BqRaw>(join(THESIS, "raw", `bq_${id}.json`));
const bqSqlText = (id: string): string | null =>
  existsSync(join(THESIS, "sql", "bigquery", `${id}.sql`))
    ? readFileSync(join(THESIS, "sql", "bigquery", `${id}.sql`), "utf8")
    : null;

mkdirSync(join(THESIS, "raw"), { recursive: true });
mkdirSync(join(THESIS, "sql", "executed"), { recursive: true });

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

const unchanged =
  prevManifest !== null &&
  prevManifest.datasets.length === frozen.length &&
  frozen.every((f) => prevManifest.datasets.find((d) => d.id === f.def.id)?.sha256 === f.sha);
const frozenAt = unchanged && prevManifest ? prevManifest.frozenAt : new Date().toISOString();

const byId = new Map(frozen.map((f) => [f.def.id, f]));
const col = (id: string, i: number): Array<readonly [string, string | null]> =>
  (byId.get(id)?.rows ?? []).map((r) => [String(r[0]), r[i] as string | null] as const);
const bqCol = (b: BqRaw | null, i: number): Array<readonly [string, string | null]> =>
  (b?.rows ?? []).map((r) => [String(r[0]), r[i] ?? null] as const);

const caveatsExtra = new Map<string, string[]>();
const bqInfo = new Map<string, { executed: boolean; billed: string | null }>();
for (const f of frozen) {
  const id = f.def.id;
  const b = f.def.bq ? bqRaw(f.def.bq) : null;
  bqInfo.set(id, { executed: b !== null, billed: b?.bigQuery.bytesBilled ?? null });
  const extra: string[] = [];
  if (f.def.bq && !b)
    extra.push(
      `The BigQuery source query sql/bigquery/${f.def.bq}.sql is NOT EXECUTED in this build (no result file); the local series is used.`,
    );
  if (b && f.def.bq) {
    const f0 = `raw/bq_${f.def.bq}.json`;
    const meta = `BigQuery job ${b.bigQuery.jobId} (${b.bigQuery.location}) ran ${b.bigQuery.executedAt}: dry run ${b.bigQuery.dryRunBytes} bytes, ${b.bigQuery.bytesBilled} bytes billed, ${b.rows.length} rows, result in ${f0} (sha256 ${sha256Hex(readFileSync(join(THESIS, f0), "utf8"))}).`;
    extra.push(meta);
    if (id === "transactions_daily" || id === "active_accounts_daily") {
      const c = compareIntSeries(col(id, 1), bqCol(b, 1));
      extra.push(
        `Local vs BigQuery (${id === "transactions_daily" ? "tx_count" : "distinct signers"}): ${c.daysEqual} of ${c.daysCompared} compared days are exactly equal; max absolute difference ${c.maxAbsDiff}${c.maxAbsDiffDay ? ` (on ${c.maxAbsDiffDay})` : ""}; local ${c.daysLocal} days, BigQuery ${c.daysOther} days.`,
      );
      if (id === "transactions_daily") {
        const c2 = compareIntSeries(col(id, 1), bqCol(b, 1));
        if (c2.daysEqual !== c2.daysCompared)
          extra.push(
            "The local and BigQuery series DIFFER on some days; the difference is reported here and not smoothed over.",
          );
      }
    }
    if (id === "contract_usage_daily") {
      const cd = compareIntSeries(col(id, 2), bqCol(b, 1));
      const ct = compareIntSeries(col(id, 1), bqCol(b, 2));
      extra.push(
        `NOT like-for-like. Local active contracts (receivers of function calls) vs BigQuery distinct transaction receivers: ${cd.daysEqual} of ${cd.daysCompared} days equal, max absolute difference ${cd.maxAbsDiff}${cd.maxAbsDiffDay ? ` (on ${cd.maxAbsDiffDay})` : ""}. Local function-call actions vs BigQuery transaction count: ${ct.daysEqual} of ${ct.daysCompared} days equal, max absolute difference ${ct.maxAbsDiff}${ct.maxAbsDiffDay ? ` (on ${ct.maxAbsDiffDay})` : ""}.`,
      );
    }
    if (id === "contract_usage_top") {
      const loc = (byId.get(id)?.rows ?? []).map((r) => String(r[0]));
      const bq = b.rows.map((r) => String(r[0]));
      extra.push(
        `NOT like-for-like (function-call actions locally, transactions by receiver in BigQuery): top-20 overlap ${topOverlap(loc, bq, 20)} of 20, top-50 overlap ${topOverlap(loc, bq, 50)} of 50 receivers.`,
      );
    }
  }
  caveatsExtra.set(id, extra);
}

const datasets = frozen.map((f) => {
  const { def } = f;
  const bi = bqInfo.get(def.id) ?? { executed: false, billed: null };
  const bqText = def.bq ? bqSqlText(def.bq) : null;
  const isDate = def.columns[0]?.type === "date";
  const missing = isDate ? missingDays(f.rows, FROM, TO) : [];
  const file = `raw/${def.id}.json`;
  writeFileSync(join(THESIS, file), f.text);
  writeFileSync(
    join(THESIS, "sql", "executed", `${def.id}.sql`),
    withHeader(
      [
        `thesis dataset: ${def.id}  (${def.title})`,
        `executed against: ClickHouse database nearesis_live (local, SELECT only, read-only session)`,
        `frozen at: ${frozenAt}`,
        `parameters: s = ${FROM}, e = ${TO} (inclusive; v3 research window)`,
        `rows: ${f.rows.length}`,
        `result file: ${file}`,
        `result sha256: ${f.sha}`,
        `reproduce: pnpm thesis:data`,
      ],
      def.query,
    ),
  );
  const notes: string[] = [];
  if (def.id === "intents_swaps_daily")
    notes.push("2026-07-23 is partial (see caveats); its row is present and is a lower bound.");
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
    sqlBigQuery: def.bq && bqText ? `sql/bigquery/${def.bq}.sql` : null,
    bigQueryExecuted: bi.executed,
    bigQueryBytesBilled: bi.billed,
    definition: def.definition,
    caveats: [...def.caveats, ...(caveatsExtra.get(def.id) ?? [])],
    coverage: {
      missingDays: missing,
      note: notes.length
        ? notes.join(" ")
        : missing.length === 0
          ? isDate
            ? `All ${f.rows.length} days of the window are present.`
            : null
          : null,
    },
  };
});

const manifest = {
  schema: "nearesis.thesis.raw.v1",
  frozenAt,
  window: { from: FROM, to: TO },
  datasets,
};
writeFileSync(join(THESIS, "raw", "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    frozenAt,
    unchanged,
    window: manifest.window,
    datasets: datasets.map((d) => ({
      id: d.id,
      rows: d.rows,
      sha256: d.sha256.slice(0, 12),
      bq: d.bigQueryExecuted,
    })),
  }),
);

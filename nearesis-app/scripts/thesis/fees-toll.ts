/**
 * pnpm thesis:toll — turns the spread and app-fee outputs of `thesis:spread` (thesis/raw/fees/spread_daily.json,
 * app_fees_daily.json) into one daily raw file in the thesis manifest shape, `raw/fees/toll_daily.json`, and registers it in
 * `thesis/raw/fees/manifest.json` so `thesis:build` can forecast and cite it. Offline and deterministic: no network, no
 * database. Values are copied as exact decimal strings; the only computed column is app fees in basis points, done in exact
 * integer arithmetic (rounded half away from zero to six decimals). A day with no usable value stays null, never zero.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { serializeRaw, type RawColumn } from "./data-lib.ts";

const APP = resolve(import.meta.dirname, "..", "..");
const FEES = join(APP, "thesis", "raw", "fees");
const sha = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

type SpreadRow = { period: string; grp: string; vw_mean_bps: string | null; clean_spread_usd: string | null; clean_in_usd: string | null };
type AppRow = { day: string; input_usd_success: string | null; app_fee_usd: string | null };

/** Exact decimal string -> [integer, scale]. */
function parse(d: string): [bigint, number] {
  const neg = d.startsWith("-");
  const [i, f = ""] = (neg ? d.slice(1) : d).split(".");
  const v = BigInt(`${i}${f}` || "0");
  return [neg ? -v : v, f.length];
}
/** a / b * 10000 as a decimal string with 6 decimals (half away from zero); null when b is zero or missing. */
export function bpsOf(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const [av, as] = parse(a);
  const [bv, bs] = parse(b);
  if (bv === 0n) return null;
  // value = (av / 10^as) / (bv / 10^bs) * 10^4, scaled by 10^6 for six decimals
  let num = av * 10n ** BigInt(bs) * 10n ** 10n;
  let den = bv * 10n ** BigInt(as);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const q = num / den;
  const r = num % den;
  const rounded = 2n * (r < 0n ? -r : r) >= den ? q + (num < 0n ? -1n : 1n) : q;
  const neg = rounded < 0n;
  const s = (neg ? -rounded : rounded).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${s.slice(0, -6)}.${s.slice(-6)}`;
}

export function buildToll(spread: SpreadRow[], app: AppRow[]): { columns: RawColumn[]; rows: (string | null)[][] } {
  const byDay = new Map<string, Record<string, string | null>>();
  const at = (d: string) => byDay.get(d) ?? byDay.set(d, {}).get(d)!;
  for (const r of spread) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.period)) continue;
    if (r.grp === "all") {
      at(r.period).spread_bps_all = r.vw_mean_bps;
      at(r.period).spread_usd_all = r.clean_spread_usd;
      at(r.period).clean_in_usd_all = r.clean_in_usd;
    }
    if (r.grp === "stable_to_stable") at(r.period).spread_bps_stable = r.vw_mean_bps;
  }
  for (const r of app) {
    at(r.day).app_fee_usd = r.app_fee_usd;
    at(r.day).app_fee_bps = bpsOf(r.app_fee_usd, r.input_usd_success);
  }
  const names = ["spread_bps_all", "spread_bps_stable", "spread_usd_all", "clean_in_usd_all", "app_fee_usd", "app_fee_bps"];
  const columns: RawColumn[] = [{ name: "d", type: "date" }, ...names.map((name) => ({ name, type: "decimal-string|null" }) as RawColumn)];
  const rows = [...byDay.keys()].sort().map((d) => [d, ...names.map((n) => byDay.get(d)![n] ?? null)]);
  return { columns, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spread = JSON.parse(readFileSync(join(FEES, "spread_daily.json"), "utf8")) as { rows: SpreadRow[] };
  const app = JSON.parse(readFileSync(join(FEES, "app_fees_daily.json"), "utf8")) as { rows: AppRow[] };
  const { columns, rows } = buildToll(spread.rows, app.rows);
  const text = serializeRaw(columns, rows);
  writeFileSync(join(FEES, "toll_daily.json"), text);
  const mp = join(FEES, "manifest.json");
  const m = JSON.parse(readFileSync(mp, "utf8")) as { datasets: Array<Record<string, unknown>> };
  const entry = {
    id: "toll_daily",
    title: "User-paid toll per day: swap spread and integrator app fees",
    unit: "basis points of settled USD; USD",
    file: "raw/fees/toll_daily.json",
    sha256: sha(text),
    rows: rows.length,
    columns,
    source: "Intents Explorer API swap records (archived raw pages and the intents_swaps table)",
    sqlExecuted: "raw/fees/spread_daily.sql",
    sqlBigQuery: null,
    bigQueryExecuted: false,
    bigQueryBytesBilled: null,
    definition:
      "spread = USD in minus USD out of successful swaps with both marks, volume-weighted in basis points of input, per route group (all routes; both legs USD stablecoins); app fees = the integrator appFees on each successful swap (input USD x fee bps / 10000), and app_fee_bps = app fee USD / successful input USD x 10000.",
    caveats: [
      "Swaps whose spread exceeds 20 percent of input are pricing artefacts, reported separately in spread_daily.json and excluded here.",
      "The spread mixes the solver margin, the 1Click fee, app fees, the protocol fee and price movement between quote and settlement; only app fees are separable.",
      "Confidential (private) settlement is not in the Explorer data; all figures describe the public flow.",
      "See raw/fees/SPREAD_NOTES.md and raw/fees/FEE_MODEL.md.",
    ],
    coverage: { missingDays: [], note: "copied from spread_daily.json and app_fees_daily.json, which list no missing days" },
  };
  m.datasets = [...m.datasets.filter((d) => d.id !== "toll_daily"), entry];
  writeFileSync(mp, `${JSON.stringify(m, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, rows: rows.length, sha256: entry.sha256 }));
}

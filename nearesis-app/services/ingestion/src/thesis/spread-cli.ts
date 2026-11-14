import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { APP_ROOT } from "../backfill/env.ts";
import {
  addFeeItem,
  emptyFeeAgg,
  formatFeeUsd,
  formatScaled,
  missingDays,
  sha256Hex,
  spreadAggSql,
  toFeeItem,
  topShares,
  USD_SCALE,
  type FeeAgg,
  type Grain,
} from "./spread-core.ts";

/**
 * Thesis fee measurement. Read-only: ClickHouse SELECTs and local reads of the archived raw Explorer pages.
 *   tsx src/thesis/spread-cli.ts spread [--out thesis/raw/fees]
 *   tsx src/thesis/spread-cli.ts appfees [--out thesis/raw/fees] [--raw .data/backfill/raw]
 * Needs node --max-old-space-size=6000 for `appfees` (about 7 million swap keys held as 52-bit hashes).
 */
const { positionals, values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  allowPositionals: true,
  options: {
    out: { type: "string", default: "thesis/raw/fees" },
    raw: { type: "string", default: ".data/backfill/raw" },
    "raw-live": { type: "string", default: ".data/scheduler/raw" },
    from: { type: "string", default: "2025-11-09" },
    to: { type: "string", default: "2026-11-13" },
  },
});
const OUT = join(APP_ROOT, values.out!);
const RAW_DIRS = [join(APP_ROOT, values.raw!), join(APP_ROOT, values["raw-live"]!)];
mkdirSync(OUT, { recursive: true });

function ch(): ClickHouseClient {
  return createClient({
    url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
    username: process.env.NEARESIS_CH_USER ?? "nearesis",
    password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
    database: "nearesis_live",
    clickhouse_settings: { readonly: "2", max_memory_usage: "20000000000" },
    request_timeout: 600_000,
  });
}
type Row = Record<string, string | number | null>;
async function select(c: ClickHouseClient, sql: string): Promise<Row[]> {
  if (!/^\s*(WITH|SELECT)\b/i.test(sql)) throw new Error("SELECT-only");
  const rs = await c.query({
    query: sql,
    format: "JSONEachRow",
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 },
  });
  return (await rs.json()) as Row[];
}

function writeOutput(name: string, doc: unknown, sql: string): void {
  const json = JSON.stringify(doc, null, 1) + "\n";
  writeFileSync(join(OUT, `${name}.json`), json);
  writeFileSync(join(OUT, `${name}.sql`), sql.endsWith("\n") ? sql : sql + "\n");
  writeFileSync(
    join(OUT, `${name}.sha256`),
    `${sha256Hex(json)}  ${name}.json\n${sha256Hex(sql.endsWith("\n") ? sql : sql + "\n")}  ${name}.sql\n`,
  );
  console.log(`wrote ${name}.json sha256=${sha256Hex(json)}`);
}

const NOTE =
  "Decimal strings are exact ClickHouse Decimal output (USD) or rounded to 6 dp (bps). Missing periods are listed in " +
  "missing_periods and never zero-filled. spread = amount_in_usd - amount_out_usd of SUCCESS swaps with both marks > 0; " +
  "|spread| > 20% of input is an artefact: reported in artefact_* columns, excluded from every clean_*/bps statistic.";

async function runSpread(): Promise<void> {
  const c = ch();
  try {
    for (const [name, grain] of [
      ["spread_daily", "day"],
      ["spread_by_route_type_monthly", "month"],
    ] as [string, Grain][]) {
      const sqlRoute = spreadAggSql(grain, true);
      const sqlAll = spreadAggSql(grain, false);
      const rows = [...(await select(c, sqlAll)), ...(await select(c, sqlRoute))];
      rows.sort(
        (a, b) =>
          String(a.period).localeCompare(String(b.period)) || String(a.grp).localeCompare(String(b.grp)),
      );
      const periods = new Set(rows.filter((r) => r.grp === "all").map((r) => String(r.period)));
      const first = rows.length ? String(rows[0]!.period) : "";
      const missing = grain === "day" ? missingDays(values.from!, values.to!, periods) : [];
      writeOutput(
        name,
        {
          grain,
          note: NOTE,
          groups:
            "all | stable_to_stable | same_asset_cross_chain | volatile_other | unclassified (definitions in SPREAD_NOTES.md)",
          first_period: first,
          range_checked: grain === "day" ? [values.from, values.to] : null,
          missing_periods: missing,
          rows,
        },
        `-- pooled ('all') query\n${sqlAll};\n\n-- by route type query\n${sqlRoute};\n`,
      );
    }
    // Headline windows over the pooled daily output, computed with the same populations.
    const win = (a: string, b: string, route: boolean): string =>
      `${spreadAggSql("day", route)
        .replace(
          /SELECT\n {2}toString\(d\) AS period,/,
          "SELECT\n  concat('" + a + "..." + b + "') AS period,",
        )
        .replace(
          "FROM base\nGROUP BY period, grp",
          `FROM base\nWHERE d BETWEEN '${a}' AND '${b}'\nGROUP BY period, grp`,
        )}`;
    const dayMs = 86_400_000;
    const last = Date.parse(values.to! + "T00:00:00Z");
    const lastFrom = new Date(last - 89 * dayMs).toISOString().slice(0, 10);
    const firstTo = new Date(Date.parse(values.from! + "T00:00:00Z") + 89 * dayMs).toISOString().slice(0, 10);
    const windows = [
      { label: "first_90_days", from: values.from!, to: firstTo },
      { label: "last_90_days", from: lastFrom, to: values.to! },
    ];
    const out: unknown[] = [];
    let sqlAll = "";
    for (const w of windows) {
      const s1 = win(w.from, w.to, false);
      const s2 = win(w.from, w.to, true);
      sqlAll += `-- ${w.label}\n${s1};\n${s2};\n\n`;
      out.push({ ...w, days: 90, rows: [...(await select(c, s1)), ...(await select(c, s2))] });
    }
    writeOutput("spread_headline_windows", { note: NOTE, windows: out }, sqlAll);

    // Visibility: what the Explorer still shows by privacy era and leg type.
    const vis = `SELECT formatDateTime(created_day, '%Y-%m') AS month, privacy_era, deposit_type, recipient_type, count() AS n_success,
  toString(sum(amount_in_usd)) AS in_usd, countIf(amount_in_usd IS NULL) AS n_no_in_usd
FROM nearesis_live.intents_swaps FINAL WHERE status = 'SUCCESS'
GROUP BY month, privacy_era, deposit_type, recipient_type ORDER BY month, privacy_era, deposit_type, recipient_type`;
    writeOutput("visibility_by_leg_type_monthly", { note: NOTE, rows: await select(c, vis) }, vis);
  } finally {
    await c.close();
  }
}

/* ---------------- raw app-fee scan ---------------- */

const md5Key = (k: string): number => {
  const b = createHash("md5").update(k).digest();
  return b.readUIntBE(0, 6) + (b[6]! & 0x0f) * 2 ** 48;
};

function isExplorerFile(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(24);
    const n = readSync(fd, buf, 0, 24, 0);
    return buf.subarray(0, n).toString("utf8").startsWith('[{"originAsset"');
  } finally {
    closeSync(fd);
  }
}

async function runAppFees(): Promise<void> {
  const c = ch();
  let order: string[];
  try {
    const sql = `SELECT raw_object_hash AS h FROM nearesis_live.intents_swaps FINAL GROUP BY raw_object_hash ORDER BY max(fetched_at), raw_object_hash`;
    order = (await select(c, sql)).map((r) => String(r.h));
  } finally {
    await c.close();
  }
  // hash -> directory (backfill pages and live forward pages are two content-addressed stores)
  const have = new Map<string, string>();
  for (const dir of RAW_DIRS)
    for (const sub of readdirSync(dir))
      for (const f of readdirSync(join(dir, sub))) if (!have.has(f)) have.set(f, dir);
  const files = order.filter((h) => have.has(h));
  const missingFiles = order.length - files.length;
  const pathOf = (h: string): string => join(have.get(h)!, h.slice(0, 2), h);
  console.log(`pages: ${order.length} referenced by ClickHouse, ${files.length} present on disk`);

  // Pass 1: last page (by fetch order) in which each swap key appears.
  const last = new Map<number, number>();
  let pageCount = 0;
  const explorer: number[] = [];
  for (const [ord, h] of files.entries()) {
    const p = pathOf(h);
    if (!isExplorerFile(p)) continue;
    explorer.push(ord);
    const arr = JSON.parse(readFileSync(p, "utf8")) as unknown[];
    for (const raw of arr) {
      const it = toFeeItem(raw);
      if (it) last.set(md5Key(it.key), ord);
    }
    if (++pageCount % 500 === 0) console.log(`pass1 ${pageCount}/${explorer.length}+ keys=${last.size}`);
  }
  console.log(`pass1 done: ${pageCount} explorer pages, ${last.size} distinct swaps`);

  // Pass 2: aggregate each swap once, from its latest page; census of fields and types.
  const daily = new Map<string, FeeAgg>();
  const nonSuccessFee = new Map<string, number>();
  const recipients = new Map<string, bigint>();
  const referrals = new Map<string, bigint>();
  const referralSwaps = new Map<string, number>();
  const recipientSwaps = new Map<string, number>();
  const bpsHist = new Map<number, number>();
  const recBps = new Map<string, Map<number, number>>();
  const dayMs = 86_400_000;
  const w1 = values.from!;
  const w1End = new Date(Date.parse(w1 + "T00:00:00Z") + 89 * dayMs).toISOString().slice(0, 10);
  const w2End = values.to!;
  const w2 = new Date(Date.parse(w2End + "T00:00:00Z") - 89 * dayMs).toISOString().slice(0, 10);
  const recWin = new Map<string, [bigint, bigint]>();
  const census = new Map<string, Map<string, number>>();
  let items = 0;
  let counted = 0;
  let p2 = 0;
  for (const ord of explorer) {
    const arr = JSON.parse(readFileSync(pathOf(files[ord]!), "utf8")) as Record<string, unknown>[];
    for (const raw of arr) {
      items++;
      for (const [k, v] of Object.entries(raw)) {
        const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
        let m = census.get(k);
        if (!m) census.set(k, (m = new Map()));
        m.set(t, (m.get(t) ?? 0) + 1);
      }
      const it = toFeeItem(raw);
      if (!it || last.get(md5Key(it.key)) !== ord) continue;
      counted++;
      if (it.status !== "SUCCESS") {
        if (it.fees.length) nonSuccessFee.set(it.status, (nonSuccessFee.get(it.status) ?? 0) + 1);
        continue;
      }
      let a = daily.get(it.day);
      if (!a) daily.set(it.day, (a = emptyFeeAgg()));
      addFeeItem(a, it);
      if (it.inUsd !== null) {
        for (const f of it.fees) {
          recipients.set(f.recipient, (recipients.get(f.recipient) ?? 0n) + it.inUsd * BigInt(f.bps));
          recipientSwaps.set(f.recipient, (recipientSwaps.get(f.recipient) ?? 0) + 1);
          bpsHist.set(f.bps, (bpsHist.get(f.bps) ?? 0) + 1);
          let rb = recBps.get(f.recipient);
          if (!rb) recBps.set(f.recipient, (rb = new Map()));
          rb.set(f.bps, (rb.get(f.bps) ?? 0) + 1);
          const inFirst = it.day >= w1 && it.day <= w1End;
          const inLast = it.day >= w2 && it.day <= w2End;
          if (inFirst || inLast) {
            let w = recWin.get(f.recipient);
            if (!w) recWin.set(f.recipient, (w = [0n, 0n]));
            if (inFirst) w[0] += it.inUsd * BigInt(f.bps);
            if (inLast) w[1] += it.inUsd * BigInt(f.bps);
          }
        }
        if (it.referral && it.fees.length) {
          let t = 0n;
          for (const f of it.fees) t += it.inUsd * BigInt(f.bps);
          referrals.set(it.referral, (referrals.get(it.referral) ?? 0n) + t);
        }
      }
      if (it.referral) referralSwaps.set(it.referral, (referralSwaps.get(it.referral) ?? 0) + 1);
    }
    if (++p2 % 500 === 0) console.log(`pass2 ${p2}/${explorer.length}`);
  }

  const days = [...daily.keys()].sort();
  const dayRows = days.map((d) => {
    const a = daily.get(d)!;
    return {
      day: d,
      swaps_success: a.swaps,
      swaps_with_app_fee: a.swapsWithFee,
      swaps_with_referral: a.swapsWithReferral,
      swaps_with_app_fee_but_no_input_usd: a.feeNoUsd,
      input_usd_success: formatScaled(a.inUsd, USD_SCALE),
      input_usd_of_swaps_with_app_fee: formatScaled(a.inUsdWithFee, USD_SCALE),
      app_fee_usd: formatFeeUsd(a.feeScaled4),
    };
  });
  const sql =
    "-- No SQL: this output is produced by scanning archived raw Explorer pages (.data/backfill/raw/<hash[0:2]>/<hash>)\n" +
    "-- in the order of their fetch time recorded in ClickHouse; each swap is counted once from its latest page.\n" +
    "-- Page list (ClickHouse, SELECT only):\n" +
    "SELECT raw_object_hash AS h FROM nearesis_live.intents_swaps FINAL GROUP BY raw_object_hash ORDER BY max(fetched_at), raw_object_hash;\n" +
    "-- Fee USD = amountInUsd (input) x appFees[].fee / 10000, summed over fee entries (fee is integer basis points per the 1Click docs).\n";
  const head = {
    note:
      "app_fee_usd is the integrator-configured appFees (recipient, fee in bps) charged on the input amount; the 1Click or " +
      "protocol share is NOT listed in appFees and is not in these numbers. SUCCESS swaps only. Days with no SUCCESS swap are listed in missing_days.",
    windows: { first_90_days: [w1, w1End], last_90_days: [w2, w2End] },
    pages_present: files.length,
    pages_referenced_missing_on_disk: missingFiles,
    explorer_pages_scanned: explorer.length,
    items_read: items,
    distinct_swaps_counted: counted,
    non_success_swaps_with_app_fee_by_status: Object.fromEntries(nonSuccessFee),
    missing_days: missingDays(values.from!, values.to!, days),
  };
  writeOutput("app_fees_daily", { ...head, rows: dayRows }, sql);
  const top = (m: Map<string, bigint>, extra: Map<string, number>) =>
    topShares(m, 15).map((t) => ({
      label: t.label,
      app_fee_usd: formatFeeUsd(t.usdScaled4),
      share_of_total_app_fee_usd: t.share,
      swaps: extra.get(t.label) ?? 0,
      most_common_fee_bps: [...(recBps.get(t.label) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([bps, n]) => ({ bps, entries: n })),
      app_fee_usd_first_90_days: formatFeeUsd(recWin.get(t.label)?.[0] ?? 0n),
      app_fee_usd_last_90_days: formatFeeUsd(recWin.get(t.label)?.[1] ?? 0n),
    }));
  let totalFee = 0n;
  for (const v of recipients.values()) totalFee += v;
  writeOutput(
    "app_fee_recipients_top",
    {
      ...head,
      total_app_fee_usd: formatFeeUsd(totalFee),
      distinct_recipients: recipients.size,
      top_recipients: top(recipients, recipientSwaps),
      top_referral_labels_by_attached_app_fee_usd: top(referrals, referralSwaps),
      fee_bps_histogram_top: [...bpsHist.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([bps, n]) => ({ bps, entries: n })),
    },
    sql,
  );
  const cen = Object.fromEntries([...census.entries()].sort().map(([k, m]) => [k, Object.fromEntries(m)]));
  writeOutput(
    "raw_field_census",
    {
      note: "Field names and JSON types across every raw Explorer item read (counts of items).",
      items_read: items,
      fields: cen,
    },
    sql,
  );
}

if (positionals[0] === "spread") await runSpread();
else if (positionals[0] === "appfees") await runAppFees();
else {
  console.error("usage: spread-cli.ts spread|appfees [--out dir]");
  process.exit(2);
}

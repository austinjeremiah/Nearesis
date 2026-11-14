import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { DAILY_LIMIT_BYTES } from "../backfill/budget.ts";
import { openArchive } from "../backfill/env.ts";
import { addDays, WINDOW_FROM, WINDOW_TO } from "../backfill/plan.ts";
import { fmtUsd, ON_DEMAND_USD_PER_TIB, PRICE_SOURCE_URL, usdForBytes } from "./pricing.ts";
import { dryRunEconomics, packIntoQuotaDays, planDigest, planFittingChunks, toGiB } from "./run.ts";
import {
  economicsSql,
  planDailyChunks,
  planEconomicsChunks,
  type EconomicsChunk,
  type EconomicsFamily,
} from "./sql.ts";

/**
 * FREE ONLY. Prints approval packets (exact SQL digest, per-chunk dry-run bytes, USD at list price). It never creates a
 * billed job: there is deliberately no billed mode in this CLI (a billed run needs the owner's digest and byte authorisation
 * via runEconomicsPhase).
 *   --pilot               seven daily chunks of the lean families + one A18 full-outcomes validation day (--from picks day 1)
 *   --daily <YYYY-MM-DD>  one forward incremental day (lean families)
 *   --from/--to           month chunks of the lean families (history plan)
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    sql: { type: "boolean" },
    pilot: { type: "boolean" },
    daily: { type: "string" },
    "include-tx-cost": { type: "boolean" },
  },
});
const PILOT_DAYS = 7;
const pilotFrom = values.from ?? "2026-11-03";
let plan: EconomicsChunk[];
if (values.pilot) {
  plan = planDailyChunks(pilotFrom, addDays(pilotFrom, PILOT_DAYS));
  const ref = pilotFrom;
  const extra: EconomicsFamily[] = [
    "outcomes_full",
    ...(values["include-tx-cost"] ? (["tx_cost"] as const) : []),
  ];
  plan.push(...planDailyChunks(ref, addDays(ref, 1), extra));
} else if (values.daily) {
  plan = planDailyChunks(values.daily, addDays(values.daily, 1));
} else {
  plan = planEconomicsChunks(values.from ?? WINDOW_FROM, values.to ?? WINDOW_TO);
}
if (values.sql) {
  for (const c of plan) console.log(`-- ${c.id} [${c.from}, ${c.to})\n${economicsSql(c)};\n`);
  process.exit(0);
}
const bq = createBigQueryClient();
const discovery = await new BudgetedBigQuery(bq, openArchive(null)).discover(adcCredentialKind());
const fitted =
  values.pilot || values.daily
    ? {
        chunks: plan,
        dry: await dryRunEconomics({ bq, location: discovery.datasetLocation, chunks: plan }),
      }
    : await planFittingChunks({
        bq,
        location: discovery.datasetLocation,
        chunks: plan,
        limitBytes: DAILY_LIMIT_BYTES,
      });
const { chunks, dry } = fitted;
const total = dry.reduce((a, d) => a + d.estimateBytes, 0);
const byFamily: Record<string, number> = {};
for (const d of dry) byFamily[d.family] = (byFamily[d.family] ?? 0) + d.estimateBytes;
const quota = packIntoQuotaDays(dry, DAILY_LIMIT_BYTES);
const packet = {
  generatedAtUTC: new Date().toISOString(),
  mode: values.pilot ? "pilot" : values.daily ? "daily" : "history",
  window: {
    from: plan.reduce((m, c) => (c.from < m ? c.from : m), plan[0]?.from ?? ""),
    to: plan.reduce((m, c) => (c.to > m ? c.to : m), ""),
  },
  digest: planDigest(chunks),
  priceUsdPerTiB: ON_DEMAND_USD_PER_TIB,
  priceSource: PRICE_SOURCE_URL,
  dailyLimitBytes: DAILY_LIMIT_BYTES,
  totalBytes: total,
  totalGiB: toGiB(total),
  totalUsdListPrice: Number(usdForBytes(total).toFixed(6)),
  byFamilyBytes: byFamily,
  chunks: dry.map((d) => ({ ...d, usdListPrice: Number(usdForBytes(d.estimateBytes).toFixed(6)) })),
  quotaDays: quota.days,
  oversize: quota.oversize,
};
for (const d of dry)
  console.log(
    `${d.id}\t${d.estimateBytes}\t${toGiB(d.estimateBytes)} GiB\t${fmtUsd(usdForBytes(d.estimateBytes))}`,
  );
console.log(
  `total ${total} B = ${toGiB(total)} GiB = ${fmtUsd(usdForBytes(total))} at ${ON_DEMAND_USD_PER_TIB}/TiB; quota days ${quota.days.length}; digest ${packet.digest}`,
);
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(packet, null, 2)}\n`);
}

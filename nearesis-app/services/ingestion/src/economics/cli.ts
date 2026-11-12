import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { DAILY_LIMIT_BYTES } from "../backfill/budget.ts";
import { openArchive } from "../backfill/env.ts";
import { WINDOW_FROM, WINDOW_TO } from "../backfill/plan.ts";
import { packIntoQuotaDays, planFittingChunks, planDigest, toGiB } from "./run.ts";
import { economicsSql, planEconomicsChunks } from "./sql.ts";

/**
 * FREE ONLY. Prints the approval packet (exact SQL digest, per-chunk dry-run bytes, quota-day packing). It never creates a
 * billed job: there is deliberately no billed mode in this CLI (a billed run needs the owner's digest via runEconomicsPhase).
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    from: { type: "string" },
    to: { type: "string" },
    out: { type: "string" },
    sql: { type: "boolean" },
  },
});
const monthly = planEconomicsChunks(values.from ?? WINDOW_FROM, values.to ?? WINDOW_TO);
if (values.sql) {
  for (const c of monthly) console.log(`-- ${c.id} [${c.from}, ${c.to})\n${economicsSql(c)};\n`);
  process.exit(0);
}
const bq = createBigQueryClient();
const discovery = await new BudgetedBigQuery(bq, openArchive(null)).discover(adcCredentialKind());
const { chunks, dry } = await planFittingChunks({
  bq,
  location: discovery.datasetLocation,
  chunks: monthly,
  limitBytes: DAILY_LIMIT_BYTES,
});
const total = dry.reduce((a, d) => a + d.estimateBytes, 0);
const plan = packIntoQuotaDays(dry, DAILY_LIMIT_BYTES);
const packet = {
  generatedAtUTC: new Date().toISOString(),
  window: { from: values.from ?? WINDOW_FROM, to: values.to ?? WINDOW_TO },
  digest: planDigest(chunks),
  dailyLimitBytes: DAILY_LIMIT_BYTES,
  totalBytes: total,
  totalGiB: toGiB(total),
  chunks: dry,
  quotaDays: plan.days,
  oversize: plan.oversize,
};
for (const d of dry) console.log(`${d.id}\t${d.estimateBytes}\t${toGiB(d.estimateBytes)} GiB`);
console.log(
  `total ${total} B = ${toGiB(total)} GiB; quota days needed (95% of 100 GiB each): ${plan.days.length}; digest ${packet.digest}`,
);
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(packet, null, 2)}\n`);
}

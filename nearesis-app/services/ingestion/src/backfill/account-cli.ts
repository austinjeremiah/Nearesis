import { parseArgs } from "node:util";
import { join } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery, mib } from "./bq-runner.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "./budget.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "./ch.ts";
import { DATA_DIR, openArchive, openLivePg } from "./env.ts";
import { AccountStateStore, runAccountPhase } from "./account-run.ts";
import { planAccountChunks } from "./account-sql.ts";
import { quotaDayStart, WINDOW_FROM, WINDOW_TO } from "./plan.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "dry-run": { type: "boolean" }, // free dry runs only, nothing billed, nothing written
    plan: { type: "boolean" },
    "only-chunk": { type: "string" },
    from: { type: "string" },
    to: { type: "string" }, // inclusive
  },
});
const log = (m: string): void => console.log(`[account ${new Date().toISOString()}] ${m}`);
const store = new AccountStateStore(join(DATA_DIR, "account-state.json"));
let chunks = planAccountChunks(values.from ?? WINDOW_FROM, values.to ?? WINDOW_TO);
if (values["only-chunk"]) chunks = chunks.filter((c) => c.id === values["only-chunk"]);
if (values.plan) {
  for (const c of chunks)
    console.log(`${store.isDone(c.id) ? "DONE   " : "PENDING"} ${c.id} [${c.from}, ${c.to})`);
  process.exit(0);
}

const bq = createBigQueryClient();
const runner = new BudgetedBigQuery(bq, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const since = quotaDayStart(Date.now());
// the budget probe is itself a (tiny) billed query: never run it in dry-run mode
const reading = values["dry-run"]
  ? { bytes: 0, jobs: 0 }
  : await runner.billedSince(discovery.datasetLocation, since.toISOString());
const ledger = new BudgetLedger(reading.bytes);
log(
  `quota day start ${since.toISOString()}; billed so far ${values["dry-run"] ? "not probed (dry run)" : `${mib(reading.bytes)} MiB over ${reading.jobs} jobs`}; limit ${mib(DAILY_LIMIT_BYTES)} MiB; remaining ${mib(ledger.remaining)} MiB`,
);
if (values["dry-run"]) {
  const r = await runAccountPhase({
    bq,
    archive: openArchive(null),
    ch: null,
    store,
    ledger,
    location: discovery.datasetLocation,
    chunks,
    dryOnly: true,
    log,
  });
  let total = 0;
  for (const d of r.dryRun) {
    total += d.estimateBytes;
    console.log(`${d.id}: ${mib(d.estimateBytes)} MiB`);
  }
  console.log(`pending total ${mib(total)} MiB; fits today whole: ${total * 1.02 <= ledger.remaining}`);
  process.exit(0);
}
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
try {
  const res = await runAccountPhase({
    bq,
    archive: openArchive(live.db),
    ch,
    store,
    ledger,
    location: discovery.datasetLocation,
    chunks,
    log,
  });
  const after = await runner.billedSince(discovery.datasetLocation, since.toISOString());
  log(
    `completed ${res.completed.length}; skipped(budget) ${res.skippedForBudget.length}; remaining ${res.remaining.length}; billed today (INFORMATION_SCHEMA) ${mib(after.bytes)} MiB of ${mib(DAILY_LIMIT_BYTES)} MiB`,
  );
} finally {
  await ch.close();
  await live.db.close();
}

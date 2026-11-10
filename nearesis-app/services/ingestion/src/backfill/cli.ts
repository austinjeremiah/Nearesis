import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "./budget.ts";
import { BudgetedBigQuery, mib } from "./bq-runner.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "./ch.ts";
import { DATA_DIR, STATE_PATH, openArchive, openLivePg, loadCredentials } from "./env.ts";
import { makeChSink, runBigQueryPhase } from "./orchestrator.ts";
import { planChunks, quotaDayStart, WINDOW_FROM, WINDOW_TO } from "./plan.ts";
import { StateStore } from "./state.ts";
import { runExplorerSession } from "./explorer-session.ts";
import { runPricePhase } from "./price-phase.ts";
import { writeRunReport, type RunSummary } from "./report.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    resume: { type: "boolean" }, // accepted for clarity; every run resumes from the checkpoint
    only: { type: "string" }, // bq | explorer | price
    plan: { type: "boolean" },
    "only-chunk": { type: "string" },
    "explorer-minutes": { type: "string" },
    "report-only": { type: "boolean" },
    reconcile: { type: "boolean" },
  },
  allowPositionals: true,
});
const only = values.only;
const want = (p: string): boolean => !values.reconcile && (only === undefined || only === p);
const log = (m: string): void => console.log(`[backfill ${new Date().toISOString()}] ${m}`);

const store = new StateStore(STATE_PATH, WINDOW_FROM, WINDOW_TO);
let chunks = planChunks();
if (values["only-chunk"]) chunks = chunks.filter((c) => c.id === values["only-chunk"]);
if (values.plan) {
  for (const c of chunks)
    console.log(`${store.isDone(c.id) ? "DONE   " : "PENDING"} ${c.id} [${c.from}, ${c.to})`);
  process.exit(0);
}

await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
const archive = openArchive(live.db);
const creds = loadCredentials();
const summary: RunSummary = {
  startedAtUTC: new Date().toISOString(),
  bigquery: null,
  explorer: null,
  price: null,
};

try {
  if (values.reconcile) {
    const runner = new BudgetedBigQuery(createBigQueryClient(), archive);
    const discovery = await runner.discover(adcCredentialKind());
    const done = Object.values(store.state.chunks).filter((c) => c.jobId);
    const since = new Date(
      Math.min(...done.map((c) => Date.parse(c.completedAtUTC))) - 3_600_000,
    ).toISOString();
    const actual = await runner.billedByJobs(
      discovery.datasetLocation,
      since,
      done.map((c) => c.jobId as string),
    );
    for (const c of done) {
      const b = actual.get(c.jobId as string);
      if (b === undefined || b === c.billedBytes) continue;
      store.state.billedByQuotaDay[c.quotaDay] =
        (store.state.billedByQuotaDay[c.quotaDay] ?? 0) - c.billedBytes + b;
      log(`reconcile ${c.id}: ${c.billedBytes} -> ${b}`);
      c.billedBytes = b;
    }
    store.save();
  }
  if (want("bq") && !values["report-only"]) {
    const bq = createBigQueryClient();
    const runner = new BudgetedBigQuery(bq, archive);
    const principal = adcCredentialKind();
    const discovery = await runner.discover(principal);
    store.state.discovery = discovery;
    store.save();
    const since = quotaDayStart(Date.now());
    const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
    const ledger = new BudgetLedger(reading.bytes);
    log(
      `quota day start ${since.toISOString()}; billed so far ${mib(reading.bytes)} MiB over ${reading.jobs} jobs; limit ${mib(DAILY_LIMIT_BYTES)} MiB; remaining ${mib(ledger.remaining)} MiB`,
    );
    const res = await runBigQueryPhase({
      runner,
      store,
      ledger,
      location: discovery.datasetLocation,
      sink: makeChSink(ch),
      chunks,
      nowMs: () => Date.now(),
      log,
    });
    // Final reconciliation against INFORMATION_SCHEMA (all jobs of the project, including other agents').
    const after = await runner.billedSince(discovery.datasetLocation, since.toISOString());
    summary.bigquery = {
      discovery,
      quotaDayStartUTC: since.toISOString(),
      billedBeforeRunBytes: reading.bytes,
      billedAfterRunBytesInformationSchema: after.bytes,
      ledgerBilledTodayBytes: ledger.billedToday,
      limitBytes: DAILY_LIMIT_BYTES,
      ...res,
    };
    log(`bq phase: ${res.stopReason}; completed ${res.completed.length}; remaining ${res.remaining.length}`);
  }
  if (want("price") && !values["report-only"])
    summary.price = await runPricePhase({ ch, archive, creds, store, log });
  if (want("explorer") && !values["report-only"])
    summary.explorer = await runExplorerSession({
      ch,
      db: live.db,
      archive,
      creds,
      store,
      minutes: Number(values["explorer-minutes"] ?? 120),
      log,
    });
  const paths = await writeRunReport({ ch, store, summary, dataDir: DATA_DIR });
  log(`report ${paths.md}`);
} finally {
  await ch.close();
  await live.db.close();
}

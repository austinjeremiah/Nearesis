import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { OneClickQuoteSampler } from "../adapters/oneclick.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { loadCredentials, openArchive, openLivePg, REDIS_URL } from "../backfill/env.ts";
import { StateStore } from "../backfill/state.ts";
import { systemClock } from "../clock.ts";
import { ALLOW_ONECLICK, HttpClient } from "../http/client.ts";
import {
  ALL_TASKS,
  FORWARD_FROM_DAY,
  loadConfig,
  quoteAddress,
  SCHEDULER_BQ_STATE_PATH,
  SCHEDULER_LEASE_KEY,
  SCHEDULER_RAW_DIR,
  SCHEDULER_STATE_PATH,
  type TaskName,
} from "./config.ts";
import { planBqDry } from "./daily.ts";
import { SchedulerLease } from "./lease.ts";
import { DEFAULT_ROUTES, limitSlots, pendingBqDays, pendingPriceDays, planQuoteGrid } from "./plan.ts";
import { Scheduler } from "./scheduler.ts";
import { SchedulerStateStore } from "./state.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    once: { type: "boolean" }, // run every due task once, then exit
    plan: { type: "boolean" }, // offline: print what is pending and due (no network, no writes)
    "dry-run": { type: "boolean" }, // BigQuery dry-run estimates + quote grid preview; nothing collected or written
    status: { type: "boolean" },
    only: { type: "string" }, // comma list of: bq,price,explorer,quotes
    "quote-limit": { type: "string" }, // cap quotes per round (bounded live checks)
    force: { type: "boolean" }, // with --once: run the selected tasks even when not due
  },
});
const log = (m: string): void => console.log(`[scheduler ${new Date().toISOString()}] ${m}`);
const only = (values.only ?? ALL_TASKS.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is TaskName => (ALL_TASKS as readonly string[]).includes(s));
const cfg = loadConfig();
if (values["quote-limit"] !== undefined) cfg.quoteLimit = Number(values["quote-limit"]);
const sched = new SchedulerStateStore(SCHEDULER_STATE_PATH);
const bqStore = new StateStore(SCHEDULER_BQ_STATE_PATH, FORWARD_FROM_DAY, FORWARD_FROM_DAY);
const now = Date.now();

if (values.status || values.plan) {
  const s = sched.state;
  log(`state ${SCHEDULER_STATE_PATH}`);
  log(`pending BigQuery days: ${pendingBqDays(now, (id) => bqStore.isDone(id)).join(",") || "none"}`);
  log(`pending price days: ${pendingPriceDays(now, s.price).join(",") || "none"}`);
  log(
    `explorer watermark: ${s.explorer.watermarkMs ? new Date(s.explorer.watermarkMs).toISOString() : "none"}; inflight window: ${s.explorer.inflight ? "yes" : "no"}`,
  );
  log(
    `quotes: rounds ${s.quotes.roundsCompleted}, last ok ${s.quotes.lastOkAtMs ? new Date(s.quotes.lastOkAtMs).toISOString() : "never"}`,
  );
  for (const t of ALL_TASKS) log(`task ${t}: ${JSON.stringify(s.tasks[t])}`);
  process.exit(0);
}

const creds = loadCredentials();

if (values["dry-run"]) {
  // Only free dry runs and one GET /v0/tokens. No ClickHouse writes, no state writes, no quote requests.
  if (only.includes("bq")) {
    const runner = new BudgetedBigQuery(createBigQueryClient(), openArchive(null, SCHEDULER_RAW_DIR));
    const disc = await runner.discover(adcCredentialKind());
    const plan = await planBqDry({
      bq: createBigQueryClient(),
      location: disc.datasetLocation,
      ledger: new BudgetLedger(0),
      bqStore,
      cfg,
      nowMs: now,
    });
    log(
      `bq dry run (budget fit assumes an empty ledger; the real run reads INFORMATION_SCHEMA first): ${JSON.stringify(plan)}`,
    );
  }
  if (only.includes("quotes")) {
    const http = new HttpClient({ allow: [ALLOW_ONECLICK], credentials: creds });
    const sampler = new OneClickQuoteSampler({
      http,
      archive: openArchive(null, SCHEDULER_RAW_DIR),
      clock: systemClock,
      sourceEnvironment: "live",
      ...(creds.has("INTENTS_1CLICK_JWT") ? { credentialName: "INTENTS_1CLICK_JWT" } : {}),
    });
    const { tokens } = await sampler.fetchTokens();
    const grid = limitSlots(
      planQuoteGrid({
        routes: DEFAULT_ROUTES,
        tokens: new Map(tokens.map((t) => [t.assetId, t])),
        notionalsUsd: cfg.quoteNotionalsUsd,
        modes: cfg.quotePrivacyModes,
        hasAddress: (k, c) => quoteAddress(creds, k, c) !== null,
      }),
      cfg.quoteLimit,
    );
    const reasons: Record<string, number> = {};
    for (const g of grid)
      if (g.unavailableReason) reasons[g.unavailableReason] = (reasons[g.unavailableReason] ?? 0) + 1;
    log(
      `quote grid: ${grid.length} slots, attemptable ${grid.filter((g) => !g.unavailableReason).length}, unavailable ${JSON.stringify(reasons)}`,
    );
  }
  process.exit(0);
}

await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
const archive = openArchive(live.db, SCHEDULER_RAW_DIR);
const lease = new SchedulerLease(new Redis(REDIS_URL, { maxRetriesPerRequest: 2 }), SCHEDULER_LEASE_KEY);
if (!(await lease.acquire())) {
  log("another scheduler instance holds the lease; exiting");
  await ch.close();
  await live.db.close();
  process.exit(3);
}
lease.startRenewing();
let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    log(`${sig}: stopping after the current step`);
    stop = true;
  });
const sleep = async (ms: number): Promise<void> => {
  for (let waited = 0; waited < ms && !stop && !lease.lost; waited += 1000)
    await new Promise((r) => setTimeout(r, Math.min(1000, ms - waited)));
};

try {
  const scheduler = new Scheduler({
    ch,
    db: live.db,
    archive,
    cfg,
    sched,
    creds,
    only,
    shouldStop: () => stop || lease.lost,
    log,
  });
  log(`started (tasks: ${only.join(",")}; ${values.once ? "once" : `tick ${cfg.tickMs / 1000}s`})`);
  if (values.once && values.force) {
    for (const t of only) {
      if (stop || lease.lost) break;
      await scheduler.runTask(t);
    }
  } else {
    do {
      await scheduler.tick();
      if (values.once) break;
      await sleep(cfg.tickMs);
    } while (!stop && !lease.lost);
  }
  if (lease.lost) log("lease lost to another instance; stopped");
} finally {
  await lease.release();
  await ch.close();
  await live.db.close();
  log("stopped");
  process.exit(0);
}

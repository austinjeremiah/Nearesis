import { installSpendGateFromEnv } from "../cost/ambient.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { OneClickQuoteSampler } from "../adapters/oneclick.ts";
import { createLiveCh, ensureDatabase, insertLive, migrateLive } from "../backfill/ch.ts";
import { loadCredentials, openArchive, openLivePg } from "../backfill/env.ts";
import { systemClock } from "../clock.ts";
import { ALLOW_ONECLICK, HttpClient } from "../http/client.ts";
import { loadConfig, SCHEDULER_RAW_DIR } from "./config.ts";
import { runQuoteRound, type QuoteRow } from "./quotes.ts";
import { SchedulerStateStore } from "./state.ts";

// NEARESIS_COST_CONTROL=1: authorise every billed BigQuery job, paid HTTP call and archive write before it runs.
await installSpendGateFromEnv();

/**
 * Bounded live validation of the dry-quote path. It does not take the scheduler lease and never touches the scheduler's
 * state file (private temp state), so it can run beside the collector. Stops at the first HTTP 429.
 * Usage: validate-quotes --limit 24 [--pace-ms 2000]
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { limit: { type: "string" }, "pace-ms": { type: "string" } },
});
const cfg = loadConfig();
cfg.quoteLimit = Number(values.limit ?? 24);
cfg.quotePaceMs = Number(values["pace-ms"] ?? 2000);
if (!(cfg.quoteLimit > 0 && cfg.quoteLimit <= 120)) throw new Error("--limit must be 1..120");
const creds = loadCredentials();
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
const archive = openArchive(live.db, SCHEDULER_RAW_DIR);
const http = new HttpClient({ allow: [ALLOW_ONECLICK], credentials: creds });
const sampler = new OneClickQuoteSampler({
  http,
  archive,
  clock: systemClock,
  sourceEnvironment: "live",
  ...(creds.has("INTENTS_1CLICK_JWT") ? { credentialName: "INTENTS_1CLICK_JWT" } : {}),
});
const store = new SchedulerStateStore(join(mkdtempSync(join(tmpdir(), "quote-validate-")), "state.json"));
let saw429 = false;
const res = await runQuoteRound({
  sampler,
  creds,
  cfg,
  store,
  nowMs: () => Date.now(),
  sleep: (ms) => systemClock.sleep(ms),
  shouldStop: () => saw429,
  insert: async (rows: QuoteRow[]) => {
    for (const r of rows) if (r.http_status === 429) saw429 = true;
    await insertLive(ch, "quote_attempts", rows);
  },
  log: (m) => console.log(`[quote-validate ${new Date().toISOString()}] ${m}`),
});
console.log(
  `[quote-validate] ${JSON.stringify({ ...res, saw429, requests: http.requestLog.map((r) => `${r.method} ${r.path} ${r.status}`).reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}) })}`,
);
await ch.close();
await live.db.close();
process.exit(saw429 ? 4 : 0);

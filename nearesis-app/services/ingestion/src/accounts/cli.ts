import { installSpendGateFromEnv } from "../cost/ambient.ts";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { BudgetedBigQuery, mib } from "../backfill/bq-runner.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../backfill/budget.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { DATA_DIR, openArchive, openLivePg } from "../backfill/env.ts";
import { nextQuotaReset, quotaDayStart, WINDOW_FROM } from "../backfill/plan.ts";
import { readRegistryMappings } from "./registry.ts";
import { reconcileScan } from "./reconcile.ts";
import { AccountScanState, runAccountScan, smokeAccountScan } from "./run.ts";
import { scanRows } from "./rows.ts";
import { addDays } from "../backfill/plan.ts";
import { HEAD_THRESHOLD, WINDOW_END_EXCLUSIVE, WINDOW_LAST_DAY } from "./sql.ts";

// Billed command. Resumable: a completed scan is checkpointed and never re-run; a budget stop prints the next quota reset.
await installSpendGateFromEnv();
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { reconcile: { type: "boolean" }, smoke: { type: "string" } },
});
const log = (m: string): void => console.log(`[accounts ${new Date().toISOString()}] ${m}`);
// A window extended by NEARESIS_ACCOUNTS_LAST_DAY is a new scan with its own checkpoint (the default window keeps its id).
const chunk = {
  id: WINDOW_LAST_DAY === "2026-11-11" ? "accounts:window" : `accounts:window:${WINDOW_LAST_DAY}`,
  from: WINDOW_FROM,
  to: WINDOW_END_EXCLUSIVE,
};
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
try {
  if (values.reconcile) {
    console.log(JSON.stringify(await reconcileScan(ch, chunk.from, chunk.to), null, 2));
    process.exit(0);
  }
  const state = new AccountScanState(join(DATA_DIR, "accounts-scan-state.json"));
  if (state.isDone(chunk.id)) {
    log(`already done: ${JSON.stringify(state.chunks[chunk.id])}`);
    process.exit(0);
  }
  const reg = await readRegistryMappings(ch);
  const bq = createBigQueryClient();
  const runner = new BudgetedBigQuery(bq, openArchive(null));
  const discovery = await runner.discover(adcCredentialKind());
  const since = quotaDayStart(Date.now());
  const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
  const ledger = new BudgetLedger(reading.bytes);
  log(
    `quota day start ${since.toISOString()}; billed so far ${mib(reading.bytes)} MiB over ${reading.jobs} jobs; limit ${mib(DAILY_LIMIT_BYTES)} MiB; remaining ${mib(ledger.remaining)} MiB`,
  );
  if (values.smoke) {
    const r = await smokeAccountScan({
      bq,
      ledger,
      location: discovery.datasetLocation,
      day: values.smoke,
      nextDay: addDays(values.smoke, 1),
      mappings: reg.mappings,
      head: HEAD_THRESHOLD,
    });
    log(`smoke ${values.smoke}: est ${r.estimateBytes} B, billed ${r.billedBytes} B, rows ${r.rows.length}`);
    const parsed = scanRows(
      r.rows,
      { rawObjectHash: "smoke", fetchedAtUTC: new Date().toISOString() },
      { head: HEAD_THRESHOLD, windowStart: values.smoke, registryVersion: reg.registryVersion },
    );
    const ex = await (
      await ch.query({
        query: `SELECT * FROM account_daily_activity FINAL WHERE block_date = '${values.smoke}'`,
        format: "JSONEachRow",
        clickhouse_settings: { output_format_json_quote_64bit_integers: 1 },
      })
    ).json();
    console.log(
      JSON.stringify(
        {
          scan: parsed.newReturning,
          existing: ex,
          tail: parsed.tail,
          headRows: parsed.head.length,
          entity: parsed.entity.map((e) => [
            e.entity_bucket,
            e.signers_all,
            e.tx_all,
            e.signers_organic,
            e.tx_organic,
          ]),
        },
        null,
        1,
      ),
    );
    process.exit(0);
  }
  const live = await openLivePg();
  try {
    const out = await runAccountScan({
      bq,
      archive: openArchive(live.db),
      ch,
      ledger,
      state,
      location: discovery.datasetLocation,
      chunk,
      mappings: reg.mappings,
      registryVersion: reg.registryVersion,
      head: HEAD_THRESHOLD,
      log,
    });
    if (out.status === "done") {
      log(`DONE ${JSON.stringify(out.done)}`);
      console.log(JSON.stringify(await reconcileScan(ch, chunk.from, chunk.to), null, 2));
    } else if (out.status === "over_approval") {
      log(
        `STOP: dry run ${out.estimateBytes} B exceeds the owner-approved ceiling ${out.approvedMaxBytes} B; nothing was run`,
      );
      process.exitCode = 3;
    } else if (out.status === "budget") {
      log(
        `DEFERRED: ${out.reason}; estimate ${out.estimateBytes} B, remaining ${out.remaining} B; rerun after ${nextQuotaReset(Date.now()).toISOString()}`,
      );
      process.exitCode = 2;
    } else log(`already done ${JSON.stringify(out.done)}`);
  } finally {
    await live.db.close();
  }
} finally {
  await ch.close();
}

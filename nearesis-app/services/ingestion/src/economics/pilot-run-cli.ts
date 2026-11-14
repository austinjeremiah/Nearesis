import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { FsObjectStore } from "../archive/object-store.ts";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import type { BigQueryJobLike } from "../adapters/bigquery.ts";
import { BudgetedBigQuery, type BqRow } from "../backfill/bq-runner.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { APP_ROOT, RAW_DIR, openArchive, openLivePg } from "../backfill/env.ts";
import { addDays, quotaDayStart } from "../backfill/plan.ts";
import { installSpendGateFromEnv } from "../cost/ambient.ts";
import { planDigest, runEconomicsPhase, type EconomicsDone } from "./run.ts";
import { economicsSql, planDailyChunks } from "./sql.ts";
import { checkGasPriceRows, compareLeanToFull, reconcileLeanToConversion } from "./reconcile.ts";
import { conversionRows, gasPriceRows, outcomeRows } from "./rows.ts";

/**
 * BILLED economics pilot (owner approval 2026-11-13, digest 68108c23..., max 2 GiB). Refuses without both flags; the
 * runner re-checks the digest. Rows are captured per chunk so every reconciliation can be computed and reported.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "approval-digest": { type: "string" },
    "approved-max-bytes": { type: "string" },
    out: { type: "string" },
  },
});
const gate = await installSpendGateFromEnv();
const FROM = "2026-11-03";
const plan = [
  ...planDailyChunks(FROM, addDays(FROM, 7)),
  ...planDailyChunks(FROM, addDays(FROM, 1), ["outcomes_full"]),
];
const digest = planDigest(plan);
console.error(`planned digest ${digest}; chunks ${plan.length}`);
const captured = new Map<string, BqRow[]>();
const real = createBigQueryClient();
const bySql = new Map(plan.map((c) => [economicsSql(c), c.id]));
const bq = {
  ...real,
  async createQueryJob(opts: Parameters<typeof real.createQueryJob>[0]) {
    const [job] = await real.createQueryJob(opts);
    if (opts.dryRun) return [job] as [BigQueryJobLike];
    const id = bySql.get(String(opts.query));
    const orig = job.getQueryResults.bind(job);
    job.getQueryResults = (async () => {
      const r = await orig();
      if (id) captured.set(id, r[0] as BqRow[]);
      return r;
    }) as typeof job.getQueryResults;
    return [job] as [BigQueryJobLike];
  },
};
const runner = new BudgetedBigQuery(real, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const since = quotaDayStart(Date.now());
const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
const ledger = new BudgetLedger(reading.bytes);
console.error(`billed today before run ${reading.bytes} B over ${reading.jobs} jobs`);
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
const dones: EconomicsDone[] = [];
const doneIds = new Set<string>();
// resume: chunks completed by an earlier invocation are not re-run; their archived rows are re-read for reconciliation
const out = values.out ?? join(APP_ROOT, ".data", "economics", "pilot-result.json");
const prior: {
  dones: EconomicsDone[];
  ledgerEntries: Array<{ id: string; estimate: number; billed: number }>;
} | null = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null;
if (prior) {
  renameSync(out, `${out}.${Date.now()}.bak`);
  const store = new FsObjectStore(RAW_DIR);
  for (const d of prior.dones) {
    dones.push(d);
    doneIds.add(d.id);
    captured.set(d.id, JSON.parse(new TextDecoder().decode(await store.get(d.rawObjectHash))) as BqRow[]);
  }
}
let err: unknown = null;
let result: Awaited<ReturnType<typeof runEconomicsPhase>> | null = null;
try {
  result = await runEconomicsPhase({
    bq,
    archive: openArchive(live.db),
    ch,
    ledger,
    location: discovery.datasetLocation,
    chunks: plan,
    approvalDigest: values["approval-digest"],
    approvedMaxBytes: values["approved-max-bytes"] ? Number(values["approved-max-bytes"]) : undefined,
    isDone: (id) => doneIds.has(id),
    markDone: (r) => {
      dones.push(r);
      doneIds.add(r.id);
    },
    log: (m) => console.error(m),
  });
} catch (e) {
  err = e;
  console.error("ERROR", e);
}
const p = { rawObjectHash: "reconcile", fetchedAtUTC: new Date().toISOString() };
const refId = `outcomes:${FROM}`;
const rec: Record<string, unknown> = {};
const lean = plan
  .filter((c) => c.family === "outcomes")
  .flatMap((c) => outcomeRows(captured.get(c.id) ?? [], p));
const conv = plan
  .filter((c) => c.family === "conversion")
  .flatMap((c) => conversionRows(captured.get(c.id) ?? [], p));
const price = plan
  .filter((c) => c.family === "gas_price")
  .flatMap((c) => gasPriceRows(captured.get(c.id) ?? [], p));
const fullRows = captured.get(`outcomes_full:${FROM}`);
if (fullRows)
  rec.leanVsFull = compareLeanToFull(
    lean.filter((r) => r.block_date === FROM),
    outcomeRows(fullRows, p),
  );
rec.leanVsConversion = reconcileLeanToConversion(
  lean,
  conv.filter((r) => r.scope === "day"),
);
rec.gasPrice = checkGasPriceRows(price);
rec.receiverSumsEqualDay = conv
  .filter((r) => r.scope === "day")
  .map((d) => {
    const R = conv.filter((r) => r.scope === "receiver" && r.block_date === d.block_date);
    const s = (f: string) => R.reduce((a, r) => a + BigInt(String(r[f])), 0n);
    return {
      day: d.block_date,
      receivers: R.length,
      txs: [String(d.txs), s("txs").toString()],
      gas: [String(d.conversion_gas), s("conversion_gas").toString()],
      tokens: [String(d.conversion_tokens_yocto), s("conversion_tokens_yocto").toString()],
      ok:
        String(d.txs) === s("txs").toString() &&
        String(d.conversion_gas) === s("conversion_gas").toString() &&
        String(d.conversion_tokens_yocto) === s("conversion_tokens_yocto").toString(),
    };
  });
rec.rowCounts = Object.fromEntries([...captured].map(([k, v]) => [k, v.length]));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      digest,
      ledgerEntries: ledger.entries,
      billedBeforeRun: reading.bytes,
      dones,
      result,
      error: err ? String(err) : null,
      reconciliation: rec,
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  ),
);
console.log(`wrote ${out}`);
await ch.close();
await live.db.close();
await gate?.close();
process.exit(err ? 1 : 0);

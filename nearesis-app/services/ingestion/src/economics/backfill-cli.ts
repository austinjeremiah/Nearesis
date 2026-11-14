import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import type { BigQueryJobLike } from "../adapters/bigquery.ts";
import { FsObjectStore } from "../archive/object-store.ts";
import { BudgetedBigQuery, type BqRow } from "../backfill/bq-runner.ts";
import { BudgetLedger, DAILY_LIMIT_BYTES } from "../backfill/budget.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { APP_ROOT, RAW_DIR, openArchive, openLivePg } from "../backfill/env.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { installSpendGateFromEnv } from "../cost/ambient.ts";
import { BACKFILL_APPROVED_MAX_BYTES, planBackfillChunks } from "./backfill-plan.ts";
import { fmtUsd, usdForBytes } from "./pricing.ts";
import { checkGasPriceRows, reconcileLeanToConversion } from "./reconcile.ts";
import { conversionRows, gasPriceRows, outcomeRows } from "./rows.ts";
import { dryRunEconomics, planDigest, runEconomicsPhase, toGiB, type EconomicsDone } from "./run.ts";
import { economicsSql } from "./sql.ts";

/**
 * 90-day economics backfill (owner approval 2026-11-13). Modes:
 *   --dry-run           FREE: dry-runs every chunk, prints per-chunk bytes + digest, writes the approval packet JSON (--packet).
 *   --run               BILLED: needs --approval-digest and --approved-max-bytes; refuses (STOP, nothing billed) when the
 *                       free dry-run total exceeds the approved maximum. No retries with changed parameters.
 * Resumable: chunks completed by an earlier invocation (result file) are not re-run and are never re-billed.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    "dry-run": { type: "boolean" },
    run: { type: "boolean" },
    "approval-digest": { type: "string" },
    "approved-max-bytes": { type: "string" },
    packet: { type: "string" },
    out: { type: "string" },
  },
});
if (!values["dry-run"] && !values.run) {
  console.error("choose --dry-run (free) or --run (billed, needs the approval flags)");
  process.exit(2);
}
const plan = planBackfillChunks();
const digest = planDigest(plan);
console.error(`plan: ${plan.length} chunks, digest ${digest}`);
const real = createBigQueryClient();
const runner = new BudgetedBigQuery(real, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const dry = await dryRunEconomics({ bq: real, location: discovery.datasetLocation, chunks: plan });
const total = dry.reduce((a, d) => a + d.estimateBytes, 0);
const byFamily: Record<string, number> = {};
for (const d of dry) byFamily[d.family] = (byFamily[d.family] ?? 0) + d.estimateBytes;
console.error(
  `dry-run total ${total} B = ${toGiB(total)} GiB = ${fmtUsd(usdForBytes(total))}; approved max ${BACKFILL_APPROVED_MAX_BYTES}`,
);
if (values["dry-run"]) {
  const packet = {
    generatedAtUTC: new Date().toISOString(),
    mode: "backfill-90d",
    digest,
    approvedMaxBytes: BACKFILL_APPROVED_MAX_BYTES,
    totalBytes: total,
    totalGiB: toGiB(total),
    totalUsdListPrice: Number(usdForBytes(total).toFixed(6)),
    withinApproval: total <= BACKFILL_APPROVED_MAX_BYTES,
    byFamilyBytes: byFamily,
    chunks: dry,
  };
  if (values.packet) {
    mkdirSync(dirname(values.packet), { recursive: true });
    writeFileSync(values.packet, `${JSON.stringify(packet, null, 2)}\n`);
  }
  console.log(JSON.stringify({ ...packet, chunks: undefined }, null, 2));
  process.exit(0);
}
const approvedMax = Number(values["approved-max-bytes"]);
if (
  values["approval-digest"] !== digest ||
  !Number.isFinite(approvedMax) ||
  approvedMax !== BACKFILL_APPROVED_MAX_BYTES
) {
  console.error(
    "STOP: approval digest or approved-max-bytes does not match the approved plan; nothing billed",
  );
  process.exit(3);
}
if (total > approvedMax) {
  console.error(`STOP: dry-run total ${total} B exceeds approved ${approvedMax} B; nothing billed`);
  process.exit(4);
}
await installSpendGateFromEnv();
const captured = new Map<string, BqRow[]>();
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
const since = quotaDayStart(Date.now());
const reading = await runner.billedSince(discovery.datasetLocation, since.toISOString());
const ledger = new BudgetLedger(reading.bytes);
console.error(
  `billed in this quota day before run ${reading.bytes} B over ${reading.jobs} jobs (limit ${DAILY_LIMIT_BYTES})`,
);
await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
const out = values.out ?? join(APP_ROOT, ".data", "economics", "backfill-90d-result.json");
const dones: EconomicsDone[] = [];
const doneIds = new Set<string>();
const prior: { dones: EconomicsDone[] } | null = existsSync(out)
  ? JSON.parse(readFileSync(out, "utf8"))
  : null;
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
const write = (): void => {
  const p = { rawObjectHash: "reconcile", fetchedAtUTC: new Date().toISOString() };
  const lean = plan
    .filter((c) => c.family === "outcomes")
    .flatMap((c) => outcomeRows(captured.get(c.id) ?? [], p));
  const conv = plan
    .filter((c) => c.family === "conversion")
    .flatMap((c) => conversionRows(captured.get(c.id) ?? [], p));
  const price = plan
    .filter((c) => c.family === "gas_price")
    .flatMap((c) => gasPriceRows(captured.get(c.id) ?? [], p));
  const dayConv = conv.filter((r) => r.scope === "day");
  const rec = {
    leanVsConversion: reconcileLeanToConversion(lean, dayConv),
    gasPrice: checkGasPriceRows(price),
    receiverSumsEqualDay: dayConv.map((d) => {
      const R = conv.filter((r) => r.scope === "receiver" && r.block_date === d.block_date);
      const s = (f: string) => R.reduce((a, r) => a + BigInt(String(r[f])), 0n);
      return {
        day: String(d.block_date),
        receivers: R.length,
        ok:
          String(d.txs) === s("txs").toString() &&
          String(d.conversion_gas) === s("conversion_gas").toString() &&
          String(d.conversion_tokens_yocto) === s("conversion_tokens_yocto").toString(),
      };
    }),
    rowCounts: Object.fromEntries([...captured].map(([k, v]) => [k, v.length])),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        digest,
        approvedMaxBytes: approvedMax,
        dryRunTotalBytes: total,
        billedBeforeRun: reading.bytes,
        ledgerEntries: ledger.entries,
        dones,
        result,
        error: err ? String(err) : null,
        reconciliation: rec,
      },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
};
try {
  result = await runEconomicsPhase({
    bq,
    archive: openArchive(live.db),
    ch,
    ledger,
    location: discovery.datasetLocation,
    chunks: plan,
    approvalDigest: values["approval-digest"],
    approvedMaxBytes: approvedMax,
    isDone: (id) => doneIds.has(id),
    markDone: (r) => {
      dones.push(r);
      doneIds.add(r.id);
      write(); // checkpoint after every job so a crash never loses a billed job id
    },
    log: (m) => console.error(m),
  });
} catch (e) {
  err = e;
  console.error("ERROR", e);
}
write();
console.log(`wrote ${out}`);
await ch.close();
await live.db.close();
process.exit(err ? 1 : 0);

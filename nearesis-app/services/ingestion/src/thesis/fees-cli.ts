import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { BigQueryJobLike } from "../adapters/bigquery.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { BudgetLedger, MIB } from "../backfill/budget.ts";
import { APP_ROOT, openArchive } from "../backfill/env.ts";
import { quotaDayStart } from "../backfill/plan.ts";
import { KEEP_ACCOUNTS } from "./fees-footprint.ts";
import {
  DISCOVERY_COLUMNS,
  discoverySql,
  feesSql,
  planFeesChunks,
  splitFeesChunk,
  type FeesChunk,
} from "./fees-sql.ts";

/**
 * Thesis fee and burn data (The Toll Booth Problem). Commands:
 *   discover [--execute]   top-40 executors of receipts that belong to transactions sent to intents.near, on three sample days
 *   plan                   dry-run every chunk (free) and print bytes per chunk, total and how it fits the remaining quota
 *   run [--execute]        run chunks newest first; completed chunks are never re-billed; stops when the quota is exhausted
 *   build                  derive the frozen raw series, manifest, SQL files and NOTES.md (no BigQuery)
 * Without --execute only dry runs happen. SELECT only; every query passes assertGuardedSql; no credentials are printed.
 */
const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  allowPositionals: true,
  options: {
    execute: { type: "boolean", default: false },
    days: { type: "string" },
    families: { type: "string" },
  },
});
const cmd = positionals[0] ?? "plan";
export const FEES_DIR = join(APP_ROOT, "thesis", "raw", "fees");
export const CHUNK_DIR = join(FEES_DIR, "chunks");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in (v as object)) return String((v as { value: unknown }).value);
  return String(v);
};
const gib = (b: number): string => (b / 1024 ** 3).toFixed(3);

interface JobRecord {
  id: string;
  family: string;
  from: string;
  to: string;
  sql: string;
  querySha256: string;
  dryRunBytes: number;
  bytesBilled: number;
  maximumBytesBilled: number;
  jobId: string | null;
  location: string;
  executedAt: string;
  rows: number;
  columns: string[];
  data: Array<Array<string | null>>;
  resultSha256: string;
}

const bq = createBigQueryClient();
const runner = new BudgetedBigQuery(bq, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const location = discovery.datasetLocation;

async function dry(sql: string): Promise<number> {
  const [d] = await bq.createQueryJob({ query: sql, dryRun: true, location, useQueryCache: false });
  const est = Number(
    d.metadata.statistics?.totalBytesProcessed ?? d.metadata.statistics?.query?.totalBytesProcessed,
  );
  if (!Number.isFinite(est)) throw new Error("dry run returned no byte estimate");
  return est;
}

async function ledgerNow(): Promise<BudgetLedger> {
  const reading = await runner.billedSince(location, quotaDayStart(Date.now()).toISOString());
  console.error(
    `location ${location}; billed this quota day ${gib(reading.bytes)} GiB (${reading.jobs} jobs); remaining ${gib(new BudgetLedger(reading.bytes).remaining)} GiB`,
  );
  return new BudgetLedger(reading.bytes);
}

async function execute(
  c: { id: string; family: string; from: string; to: string },
  sql: string,
  estimate: number,
  ledger: BudgetLedger,
  columns: string[] | null,
): Promise<JobRecord | { skipped: string }> {
  const fit = ledger.check(estimate);
  if (!fit.ok) return { skipped: fit.reason };
  const [job] = (await bq.createQueryJob({
    query: sql,
    location,
    maximumBytesBilled: String(fit.maximumBytesBilled),
    useQueryCache: false,
    labels: { source: "nearesis_thesis_fees" },
  })) as [BigQueryJobLike];
  const [rows] = await job.getQueryResults();
  let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
  if (!Number.isFinite(billed)) {
    const refresh = (job as { getMetadata?: () => Promise<[BigQueryJobLike["metadata"]]> }).getMetadata;
    if (refresh)
      billed = Number((await refresh.call(job))[0].statistics?.query?.totalBytesBilled ?? Number.NaN);
  }
  const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled; // unknown is never free
  ledger.record(c.id, estimate, billedBytes);
  const cols = columns ?? (rows.length ? Object.keys(rows[0] as object) : []);
  const data = rows.map((r) => cols.map((k) => cell((r as Record<string, unknown>)[k])));
  const rec: JobRecord = {
    id: c.id,
    family: c.family,
    from: c.from,
    to: c.to,
    sql,
    querySha256: sha(sql),
    dryRunBytes: estimate,
    bytesBilled: billedBytes,
    maximumBytesBilled: fit.maximumBytesBilled,
    jobId: job.id ?? job.metadata.jobReference?.jobId ?? null,
    location,
    executedAt: new Date().toISOString(),
    rows: data.length,
    columns: cols,
    data,
    resultSha256: sha(JSON.stringify(data)),
  };
  return rec;
}

const chunkFile = (c: Pick<FeesChunk, "family" | "from" | "to">): string =>
  join(CHUNK_DIR, `${c.family}_${c.from}_${c.to}.json`);

if (cmd === "discover") {
  const days = (values.days ?? "2026-05-13,2026-08-12,2026-10-14").split(",");
  mkdirSync(CHUNK_DIR, { recursive: true });
  const ledger = await ledgerNow();
  for (const day of days) {
    const sql = discoverySql(day);
    assertGuardedSql(sql);
    const est = await dry(sql);
    const file = join(CHUNK_DIR, `discovery_${day}.json`);
    console.log(`discovery ${day}: dry run ${gib(est)} GiB`);
    if (!values.execute || existsSync(file)) continue;
    const r = await execute(
      { id: `discovery:${day}`, family: "discovery", from: day, to: day },
      sql,
      est,
      ledger,
      DISCOVERY_COLUMNS,
    );
    if ("skipped" in r) {
      console.log(`  skipped: ${r.skipped}`);
      continue;
    }
    writeFileSync(file, JSON.stringify(r, null, 1));
    console.log(`  billed ${gib(r.bytesBilled)} GiB, job ${r.jobId}, rows ${r.rows}`);
  }
} else if (cmd === "plan" || cmd === "run") {
  mkdirSync(CHUNK_DIR, { recursive: true });
  const fam = (values.families ?? "blocks,outcomes,tx").split(",");
  const ledger = await ledgerNow();
  const queue: FeesChunk[] = planFeesChunks().filter((c) => fam.includes(c.family));
  let totalDry = 0;
  let totalBilled = 0;
  let done = 0;
  let deferredBytes = 0;
  const deferred: string[] = [];
  const lines: string[] = [];
  while (queue.length) {
    const c = queue.shift() as FeesChunk;
    if (existsSync(chunkFile(c))) {
      const prev = JSON.parse(readFileSync(chunkFile(c), "utf8")) as JobRecord;
      lines.push(`${c.id} ${c.from}..${c.to}: already done (${gib(prev.bytesBilled)} GiB billed)`);
      done++;
      totalBilled += prev.bytesBilled;
      continue;
    }
    const sql = feesSql(c, KEEP_ACCOUNTS);
    assertGuardedSql(sql);
    const est = await dry(sql);
    if (cmd === "plan") {
      totalDry += est;
      lines.push(`${c.id} ${c.from}..${c.to}: dry run ${gib(est)} GiB`);
      continue;
    }
    const fit = ledger.check(est);
    if (!fit.ok) {
      const halves = splitFeesChunk(c);
      if (halves && values.execute && ledger.remaining > 64 * MIB) {
        // a month that does not fit is split in two; the newer half goes first (newest data is the most valuable)
        queue.unshift(halves[1], halves[0]);
        continue;
      }
      deferred.push(`${c.id} ${c.from}..${c.to} ${gib(est)} GiB`);
      deferredBytes += est;
      continue;
    }
    totalDry += est;
    if (!values.execute) {
      lines.push(`${c.id} ${c.from}..${c.to}: dry run ${gib(est)} GiB (would run)`);
      continue;
    }
    const r = await execute(c, sql, est, ledger, null);
    if ("skipped" in r) {
      deferred.push(`${c.id} ${c.from}..${c.to} ${gib(est)} GiB`);
      deferredBytes += est;
      continue;
    }
    writeFileSync(chunkFile(c), JSON.stringify(r, null, 1));
    totalBilled += r.bytesBilled;
    done++;
    lines.push(
      `${c.id} ${c.from}..${c.to}: billed ${gib(r.bytesBilled)} GiB (dry ${gib(est)}), job ${r.jobId}, rows ${r.rows}`,
    );
    console.error(lines[lines.length - 1]);
  }
  console.log(lines.join("\n"));
  console.log(
    JSON.stringify(
      {
        command: cmd,
        executed: values.execute,
        chunksDone: done,
        totalDryRunGiB: gib(totalDry),
        billedThisRunAndPreviousGiB: gib(totalBilled),
        ledgerRemainingGiB: gib(ledger.remaining),
        deferredGiB: gib(deferredBytes),
        deferred,
      },
      null,
      2,
    ),
  );
} else if (cmd === "build") {
  const { buildAll } = await import("./fees-build.ts");
  const r = await buildAll({ appRoot: APP_ROOT });
  console.log(JSON.stringify(r, null, 2));
} else {
  throw new Error(`unknown command ${cmd}`);
}

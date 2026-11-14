import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import type { BigQueryJobLike } from "../adapters/bigquery.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { BudgetLedger } from "../backfill/budget.ts";
import { APP_ROOT, openArchive } from "../backfill/env.ts";
import { quotaDayStart } from "../backfill/plan.ts";

/**
 * Thesis-track BigQuery step (owner lifted the BigQuery spend limit on 2026-11-14; still frugal). For each
 * thesis/sql/bigquery/<id>.sql: static guard (finite DECLAREd block_date bounds, no OR), dry run FIRST, BudgetLedger fit
 * against the project's daily quota (billedSince), maximumBytesBilled = ceil(estimate x 1.1), then one billed job.
 * Result rows are saved to thesis/raw/bq_<id>.json and the execution record is written into the SQL file header.
 * Without --execute only dry runs happen (free). Never prints credentials.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: {
    ids: { type: "string" },
    execute: { type: "boolean", default: false },
    "max-bytes": { type: "string" },
  },
});
const THESIS = join(APP_ROOT, "thesis");
const MARK = "-- ---- query ----";
const REC_BEGIN = "-- ==== EXECUTION RECORD BEGIN ====";
const REC_END = "-- ==== EXECUTION RECORD END ====";
/** Every thesis/sql/bigquery/<id>.sql with the execution-record markers (written by pnpm thesis:data). */
const ALL_IDS = readdirSync(join(THESIS, "sql", "bigquery"))
  .filter((f) => f.endsWith(".sql"))
  .map((f) => f.slice(0, -4))
  .sort();
const ids = (values.ids ?? ALL_IDS.join(",")).split(",").filter(Boolean);
const maxBytes = values["max-bytes"] ? Number(values["max-bytes"]) : 40 * 1024 ** 3;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in (v as object)) return String((v as { value: unknown }).value);
  return String(v);
};

async function dry(
  bq: ReturnType<typeof createBigQueryClient>,
  sql: string,
  location: string,
): Promise<number> {
  const [d] = await bq.createQueryJob({ query: sql, dryRun: true, location, useQueryCache: false });
  const est = Number(
    d.metadata.statistics?.totalBytesProcessed ?? d.metadata.statistics?.query?.totalBytesProcessed,
  );
  if (!Number.isFinite(est)) throw new Error("dry run returned no byte estimate");
  return est;
}

const bq = createBigQueryClient();
const runner = new BudgetedBigQuery(bq, openArchive(null));
const discovery = await runner.discover(adcCredentialKind());
const reading = await runner.billedSince(discovery.datasetLocation, quotaDayStart(Date.now()).toISOString());
const ledger = new BudgetLedger(reading.bytes);
console.error(
  `location ${discovery.datasetLocation}; billed in quota day before run ${reading.bytes} B (${reading.jobs} jobs); remaining ${ledger.remaining} B`,
);

const summary: Array<Record<string, unknown>> = [];
for (const id of ids) {
  if (!ALL_IDS.includes(id)) throw new Error(`unknown id ${id}`);
  const path = join(THESIS, "sql", "bigquery", `${id}.sql`);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf(MARK);
  if (at < 0) throw new Error(`${id}: marker line missing`);
  const head = text.slice(0, text.indexOf(REC_BEGIN));
  const body = text.slice(at + MARK.length + 1);
  assertGuardedSql(body);
  const estimate = await dry(bq, body, discovery.datasetLocation);
  const entry: Record<string, unknown> = { id, dryRunBytes: estimate };
  summary.push(entry);
  if (!values.execute) continue;
  if (estimate > maxBytes) {
    entry.status = `skipped: estimate above --max-bytes ${maxBytes}`;
    continue;
  }
  const fit = ledger.check(estimate);
  if (!fit.ok) {
    entry.status = `skipped: ${fit.reason}`;
    continue;
  }
  const [job] = (await bq.createQueryJob({
    query: body,
    location: discovery.datasetLocation,
    maximumBytesBilled: String(fit.maximumBytesBilled),
    useQueryCache: false,
    labels: { source: "nearesis_thesis" },
  })) as [BigQueryJobLike];
  const [rows] = await job.getQueryResults();
  let billed = Number(job.metadata.statistics?.query?.totalBytesBilled ?? Number.NaN);
  if (!Number.isFinite(billed)) {
    const refresh = (job as { getMetadata?: () => Promise<[BigQueryJobLike["metadata"]]> }).getMetadata;
    if (refresh)
      billed = Number((await refresh.call(job))[0].statistics?.query?.totalBytesBilled ?? Number.NaN);
  }
  const billedBytes = Number.isFinite(billed) ? billed : fit.maximumBytesBilled; // unknown is never free
  ledger.record(id, estimate, billedBytes);
  const columns = rows.length ? Object.keys(rows[0] as object) : [];
  const out = rows.map((r) => columns.map((c) => cell((r as Record<string, unknown>)[c])));
  const executedAt = new Date().toISOString();
  const jobId = job.id ?? job.metadata.jobReference?.jobId ?? null;
  const rawBody =
    `{"columns":${JSON.stringify(columns.map((n) => ({ name: n, type: n === "block_date" ? "date" : n.endsWith("_account_id") ? "string" : "integer-string" })))},` +
    `"bigQuery":${JSON.stringify({ jobId, location: discovery.datasetLocation, executedAt, dryRunBytes: estimate, bytesBilled: String(billedBytes) })},` +
    `"rows":[\n${out.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
  const rawPath = join(THESIS, "raw", `bq_${id}.json`);
  writeFileSync(rawPath, rawBody);
  const rec = [
    REC_BEGIN,
    "-- status: EXECUTED",
    `-- executedAt: ${executedAt}`,
    `-- jobId: ${jobId}`,
    `-- jobLocation: ${discovery.datasetLocation}`,
    `-- dryRunBytes: ${estimate}`,
    `-- bytesBilled: ${billedBytes}`,
    `-- maximumBytesBilled: ${fit.maximumBytesBilled}`,
    `-- rows: ${out.length}`,
    `-- resultFile: raw/bq_${id}.json`,
    `-- resultSha256: ${sha(rawBody)}`,
    `-- querySha256: ${sha(body)}`,
    REC_END,
  ].join("\n");
  writeFileSync(path, `${head}${rec}\n${MARK}\n${body}`);
  Object.assign(entry, {
    status: "executed",
    billedBytes,
    rows: out.length,
    jobId,
    executedAt,
    resultSha256: sha(rawBody),
  });
}
console.log(
  JSON.stringify(
    {
      location: discovery.datasetLocation,
      billedBefore: reading.bytes,
      ledgerRemaining: ledger.remaining,
      summary,
    },
    null,
    2,
  ),
);

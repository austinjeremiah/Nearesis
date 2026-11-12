import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { openArchive, openLivePg } from "../backfill/env.ts";
import {
  partitionEnd,
  settlementDrySql,
  settlementSql,
  sqlDigest,
  type SettlementWindow,
} from "./settlement-sql.ts";

/** FREE ONLY: dry runs of the settlement-duration lookup for 7, 13 (all public-era days loaded in ClickHouse) and 30 days. */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { out: { type: "string" }, sql: { type: "boolean" } },
});
const WINDOWS: SettlementWindow[] = [
  { id: "7d", swapFrom: "2026-10-20", swapTo: "2026-10-26" },
  { id: "13d", swapFrom: "2026-10-14", swapTo: "2026-10-26" },
  { id: "30d", swapFrom: "2026-09-27", swapTo: "2026-10-26" },
];
const SCRATCH = "PROJECT.nearesis_scratch.settlement_hashes";
const { db } = await openLivePg();
const counts: Record<string, { swaps: number; hashes: number }> = {};
let sample: string[] = [];
for (const w of WINDOWS) {
  const r = await db.query<{ swaps: string; hashes: string }>(
    `SELECT count(*) AS swaps, coalesce(sum(jsonb_array_length(record->'nearTxHashes')),0) AS hashes
       FROM ingestion.explorer_swaps WHERE created_at >= $1::date AND created_at < ($2::date + 1)`,
    [w.swapFrom, w.swapTo],
  );
  counts[w.id] = { swaps: Number(r.rows[0]!.swaps), hashes: Number(r.rows[0]!.hashes) };
}
const s = await db.query<{ h: string }>(
  `SELECT record->'nearTxHashes'->>0 AS h FROM ingestion.explorer_swaps
    WHERE created_at >= '2026-10-20' AND created_at < '2026-10-20 00:01' AND jsonb_array_length(record->'nearTxHashes') > 0 LIMIT 3`,
);
sample = s.rows.map((r) => r.h);
await db.pool.end();
if (values.sql) {
  for (const w of WINDOWS) console.log(`-- ${w.id}\n${settlementSql(w, SCRATCH)};\n`);
  process.exit(0);
}
const bq = createBigQueryClient();
const discovery = await new BudgetedBigQuery(bq, openArchive(null)).discover(adcCredentialKind());
const GiB = 1024 ** 3;
const rows = [];
for (const w of WINDOWS) {
  const sql = settlementDrySql(w, sample);
  assertGuardedSql(sql);
  const [j] = await bq.createQueryJob({
    query: sql,
    dryRun: true,
    location: discovery.datasetLocation,
    useQueryCache: false,
  });
  const bytes = Number(j.metadata.statistics?.totalBytesProcessed ?? Number.NaN);
  rows.push({
    window: w.id,
    swapDays: `${w.swapFrom}..${w.swapTo}`,
    partitions: `[${w.swapFrom}, ${partitionEnd(w)})`,
    ...counts[w.id]!,
    dryRunBytes: bytes,
    dryRunGiB: Number((bytes / GiB).toFixed(3)),
    approvalSqlSha256: sqlDigest(settlementSql(w, SCRATCH)),
  });
  console.log(`${w.id}\t${bytes}\t${(bytes / GiB).toFixed(3)} GiB`);
}
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(
    values.out,
    `${JSON.stringify({ generatedAtUTC: new Date().toISOString(), location: discovery.datasetLocation, rows }, null, 2)}\n`,
  );
}

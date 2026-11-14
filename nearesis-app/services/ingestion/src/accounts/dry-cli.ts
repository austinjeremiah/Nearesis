import { parseArgs } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { adcCredentialKind, createBigQueryClient } from "../adapters/bigquery-client.ts";
import { assertGuardedSql } from "../adapters/bigquery-guard.ts";
import { BudgetedBigQuery } from "../backfill/bq-runner.ts";
import { createLiveCh } from "../backfill/ch.ts";
import { openArchive } from "../backfill/env.ts";
import { readRegistryMappings } from "./registry.ts";
import { accountScanSql, monthChunks, sqlDigest, WINDOW_END_EXCLUSIVE, WINDOW_FROM } from "./sql.ts";

/** FREE ONLY: dry runs of the whole-window scan and of every month chunk; prints the approval packet. Never creates a billed job. */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  options: { out: { type: "string" }, sql: { type: "boolean" } },
});
const ch = createLiveCh();
const reg = await readRegistryMappings(ch);
await ch.close();
const whole = { id: "accounts:window", from: WINDOW_FROM, to: WINDOW_END_EXCLUSIVE };
if (values.sql) {
  console.log(accountScanSql(whole, reg.mappings));
  process.exit(0);
}
const bq = createBigQueryClient();
const discovery = await new BudgetedBigQuery(bq, openArchive(null)).discover(adcCredentialKind());
const GiB = 1024 ** 3;
const rows: Array<{ id: string; from: string; to: string; bytes: number; sqlSha256: string }> = [];
for (const c of [whole, ...monthChunks(WINDOW_FROM, WINDOW_END_EXCLUSIVE)]) {
  const sql = accountScanSql(c, reg.mappings);
  assertGuardedSql(sql);
  const [j] = await bq.createQueryJob({
    query: sql,
    dryRun: true,
    location: discovery.datasetLocation,
    useQueryCache: false,
  });
  const bytes = Number(j.metadata.statistics?.totalBytesProcessed ?? Number.NaN);
  rows.push({ id: c.id, from: c.from, to: c.to, bytes, sqlSha256: sqlDigest(sql) });
  console.log(
    `${c.id}\t${c.from}..${c.to}\t${bytes}\t${(bytes / GiB).toFixed(3)} GiB\t${sqlDigest(sql).slice(0, 12)}`,
  );
}
const monthTotal = rows.slice(1).reduce((a, r) => a + r.bytes, 0);
console.log(
  `whole ${(rows[0]!.bytes / GiB).toFixed(3)} GiB; sum of months ${(monthTotal / GiB).toFixed(3)} GiB; registry ${reg.registryVersion}`,
);
if (values.out) {
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(
    values.out,
    `${JSON.stringify({ generatedAtUTC: new Date().toISOString(), registryVersion: reg.registryVersion, rows }, null, 2)}\n`,
  );
}

/**
 * Disposable LIVE-model sandbox: a ClickHouse database `a16_sandbox` (same DDL as nearesis_live, copied with CREATE TABLE AS)
 * plus its own Cube container (`a16-cube-sandbox`, port 4014, rollup schema `a16_sandbox_preagg`) running the real
 * cube-live model. Nothing here reads or writes nearesis, nearesis_live or the shared Cube instances, and it needs no
 * `semantic:testlock` (it shares no Cube state with the lock's holders; the lead's guidance is to avoid ClickHouse memory
 * contention, so the 10M load is chunked like PERF10's).
 */
import { execFileSync } from "node:child_process";
import { createCh, queryRows, type ClickHouseClient } from "../../services/analytics/src/index.ts";

export const SB_DB = "a16_sandbox";
export const SB_PREAGG = "a16_sandbox_preagg";
export const SB_NAME = "a16-cube-sandbox";
export const SB_PORT = 4014;
export const SB_URL = `http://127.0.0.1:${SB_PORT}`;
const IMAGE = "cubejs/cube:v1.8.18@sha256:d382326a0d2786242c3992f3dd462efbea82d07b2823ecdc83d619d2d6f5dcb7";
const LIVE_DIR = new URL("../../services/analytics/cube-live/", import.meta.url).pathname;
export const START_DAY = "2026-06-01";

export const docker = (...a: string[]) =>
  execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const admin = () => createCh({ database: "default" });

export async function sandboxCh(): Promise<ClickHouseClient> {
  return createCh({ database: SB_DB });
}

export async function createSandboxDb(): Promise<void> {
  const a = admin();
  try {
    await a.command({ query: `DROP DATABASE IF EXISTS ${SB_DB}` });
    await a.command({ query: `DROP DATABASE IF EXISTS ${SB_PREAGG}` });
    await a.command({ query: `CREATE DATABASE ${SB_DB}` });
    for (const t of ["intents_swaps", "source_coverage", "source_watermarks", "quality_gaps"])
      await a.command({ query: `CREATE TABLE ${SB_DB}.${t} AS nearesis_live.${t}` });
  } finally {
    await a.close();
  }
}

export async function dropSandbox(): Promise<void> {
  try {
    docker("rm", "-f", SB_NAME);
  } catch {
    /* already gone */
  }
  const a = admin();
  try {
    await a.command({ query: `DROP DATABASE IF EXISTS ${SB_DB}` });
    await a.command({ query: `DROP DATABASE IF EXISTS ${SB_PREAGG}` });
  } finally {
    await a.close();
  }
}

export async function cubeReady(deadlineMs = 180_000, url = SB_URL): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${url}/readyz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1_000);
  }
  throw new Error(`sandbox Cube not ready within ${deadlineMs} ms`);
}

export async function startSandboxCube(): Promise<void> {
  try {
    docker("rm", "-f", SB_NAME);
  } catch {
    /* none */
  }
  docker(
    "run",
    "-d",
    "--name",
    SB_NAME,
    "--network",
    "nearesis_default",
    "-p",
    `127.0.0.1:${SB_PORT}:4000`,
    "--memory",
    "1024m",
    "-e",
    "CUBEJS_DEV_MODE=false",
    "-e",
    "CUBEJS_DB_TYPE=clickhouse",
    "-e",
    "CUBEJS_DB_HOST=clickhouse",
    "-e",
    "CUBEJS_DB_PORT=8123",
    "-e",
    `CUBEJS_DB_NAME=${SB_DB}`,
    "-e",
    "CUBEJS_DB_USER=nearesis",
    "-e",
    "CUBEJS_DB_PASS=nearesis",
    "-e",
    `CUBEJS_API_SECRET=${process.env.CUBEJS_API_SECRET ?? "nearesis-dev-cube-secret-not-for-production"}`,
    "-e",
    `CUBEJS_PRE_AGGREGATIONS_SCHEMA=${SB_PREAGG}`,
    "-e",
    "CUBEJS_REFRESH_WORKER=true",
    "-e",
    "CUBEJS_SCHEDULED_REFRESH_DEFAULT=true",
    "-e",
    "CUBEJS_SCHEDULED_REFRESH_TIMER=2",
    "-e",
    "CUBEJS_CACHE_AND_QUEUE_DRIVER=memory",
    "-e",
    "CUBEJS_LOG_LEVEL=warn",
    "-e",
    "CUBEJS_TELEMETRY=false",
    "-v",
    `${LIVE_DIR}model:/cube/conf/model:ro`,
    "-v",
    `${LIVE_DIR}cube.js:/cube/conf/cube.js:ro`,
    IMAGE,
  );
  await cubeReady();
}

const INSERT_CHUNK = 500_000;
const INSERT_SETTINGS = {
  max_insert_threads: "1",
  max_threads: "2",
  min_insert_block_size_rows: "65536",
  min_insert_block_size_bytes: "33554432",
} as const;

/**
 * Deterministic swaps: row n is a pure function of n. Statuses 3:1:1 SUCCESS/FAILED/REFUNDED, two privacy eras, 5% unknown
 * USD (n % 20 = 0), and the whole of day 3 (START_DAY + 2) has NO known USD value (every swap NULL) to exercise null semantics.
 */
export const genSql = (count: number, from: number, days: number) => `
INSERT INTO ${SB_DB}.intents_swaps
SELECT concat('a16-', toString(number)) AS swap_key, concat('dep-', toString(number)) AS deposit_address, NULL AS deposit_memo,
  ['SUCCESS','SUCCESS','SUCCESS','FAILED','REFUNDED'][1 + number % 5] AS status,
  toDateTime64('${START_DAY} 00:00:00', 3, 'UTC') + toIntervalSecond(intHash32(number) % (${days} * 86400)) AS created_at,
  toDate(created_at) AS created_day,
  concat('asset-', toString(number % 40)) AS origin_asset, concat('asset-', toString((number * 7) % 40)) AS destination_asset,
  NULL AS canonical_origin_asset, NULL AS canonical_destination_asset,
  toString(1000 + number % 9000) AS amount_in_raw, toString(900 + number % 9000) AS amount_out_raw,
  toDecimal256(1000 + number % 9000, 0) AS amount_in, toDecimal256(900 + number % 9000, 0) AS amount_out, 1 AS amount_final,
  NULL AS amount_in_usd_raw, NULL AS amount_out_usd_raw,
  if(number % 20 = 0 OR created_day = toDate('${START_DAY}') + 2, CAST(NULL AS Nullable(Decimal(76, 18))), toDecimal256(1 + number % 500, 18)) AS amount_in_usd,
  toDecimal256(1 + number % 490, 18) AS amount_out_usd,
  ['direct','swap','intent'][1 + number % 3] AS deposit_type, 'address' AS recipient_type, NULL AS referral,
  ['public','private_settlement'][1 + number % 2] AS privacy_era, [] AS public_swap_tx_hashes, [] AS boundary_tx_hashes,
  'none' AS reconciliation_level, 'LIVE' AS source_label, concat('raw-', toString(number)) AS raw_object_hash,
  now64(3) AS fetched_at, 1 AS version
FROM numbers(${from}, ${count})`;

export async function loadSwaps(ch: ClickHouseClient, rows: number, days: number): Promise<void> {
  await ch.command({ query: "TRUNCATE TABLE intents_swaps" });
  for (let from = 0; from < rows; from += INSERT_CHUNK)
    await ch.command({
      query: genSql(Math.min(INSERT_CHUNK, rows - from), from, days),
      clickhouse_settings: INSERT_SETTINGS,
    });
  await ch.command({
    query: "OPTIMIZE TABLE intents_swaps FINAL",
    clickhouse_settings: { max_threads: "2" },
  });
  await writeCoverage(ch, days);
}

/** Complete coverage for every sandbox day, plus a watermark row; versioned past every earlier write. */
export async function writeCoverage(ch: ClickHouseClient, days: number): Promise<void> {
  const v = Date.now();
  await ch.command({
    query: `INSERT INTO source_coverage SELECT 'near-explorer', 'intents_swaps', toDate('${START_DAY}') + number, 'complete', NULL, 'LIVE', ${v} FROM numbers(${days})`,
  });
  await ch.command({
    query: `INSERT INTO source_watermarks SELECT 'near-explorer', now64(3), now64(3), 0, 1.0, NULL, 'fresh', ${v}`,
  });
}

export async function countRows(ch: ClickHouseClient): Promise<number> {
  return Number(
    (await queryRows<{ n: string }>(ch, "SELECT toString(count()) AS n FROM intents_swaps FINAL"))[0]!.n,
  );
}

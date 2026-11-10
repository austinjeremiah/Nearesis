import type { ClickHouseClient } from "@clickhouse/client";
import { truncateAll } from "./load.ts";
import { queryRows } from "./ch.ts";
import { cubeLoad } from "./cube.ts";

interface LockRedis {
  set(k: string, v: string, px: "PX", ms: number, nx: "NX"): Promise<unknown>;
  del(k: string): Promise<unknown>;
}

/**
 * Cube reads the shared `nearesis` database, so Cube-backed tests serialize through a Redis lock (`semantic:testlock`).
 * Returns a release function.
 */
export async function acquireDataLock(
  redis: LockRedis,
  ttlMs = 300_000,
  waitMs = 600_000,
): Promise<() => Promise<void>> {
  const token = `${process.pid}-${Math.random()}`;
  const t0 = Date.now();
  for (;;) {
    if ((await redis.set("semantic:testlock", token, "PX", ttlMs, "NX")) === "OK") break;
    if (Date.now() - t0 > waitMs) throw new Error("timed out waiting for semantic:testlock");
    await new Promise((r) => setTimeout(r, 500));
  }
  return async () => {
    await redis.del("semantic:testlock");
  };
}

interface Canary {
  rollup: string;
  member: string;
  sql: string;
  timeMember: string;
}
const CANARIES: Canary[] = [
  {
    rollup: "near_daily_usage",
    member: "near_usage.daily_successful_tx_count",
    timeMember: "near_usage.day",
    sql: "SELECT toString(sum(successful_tx_count)) AS v FROM near_daily_usage FINAL",
  },
  {
    rollup: "near_daily_usage",
    member: "near_usage.distinct_signer_proxy",
    timeMember: "near_usage.day",
    sql: "SELECT toString(sum(distinct_signer_proxy)) AS v FROM near_daily_usage FINAL",
  },
  {
    rollup: "intents_swaps",
    member: "intents.oneclick_total_swap_count",
    timeMember: "intents.day",
    sql: "SELECT toString(count()) AS v FROM intents_swaps FINAL",
  },
  {
    rollup: "intents_swaps",
    member: "intents.oneclick_completed_swap_count",
    timeMember: "intents.day",
    sql: "SELECT toString(countIf(status = 'SUCCESS')) AS v FROM intents_swaps FINAL",
  },
  {
    rollup: "intents_swaps",
    member: "intents.oneclick_failed_swap_count",
    timeMember: "intents.day",
    sql: "SELECT toString(countIf(status = 'FAILED')) AS v FROM intents_swaps FINAL",
  },
  {
    rollup: "quote_attempts",
    member: "quotes.route_quote_attempt_count",
    timeMember: "quotes.day",
    sql: "SELECT toString(countIf(slot = 'observed')) AS v FROM quote_attempts FINAL",
  },
  {
    rollup: "contract_interactions",
    member: "taxonomy.contract_interactions_by_taxonomy",
    timeMember: "taxonomy.day",
    sql: "SELECT toString(sum(interactions)) AS v FROM contract_interactions FINAL",
  },
];

/**
 * Cube rebuilds rollups asynchronously (seconds) after source data changes, so a read right after a load may be served
 * from the previous rollup version. Tests that load data call this to wait until every rollup agrees with an
 * independent ClickHouse FINAL aggregate. Production readers get the documented refresh lag instead (see FND on rollup lag).
 */
export async function settleRollups(
  ch: ClickHouseClient,
  cubeUrl: string,
  token: string,
  timeoutMs = 120_000,
): Promise<number> {
  const t0 = Date.now();
  for (const c of CANARIES) {
    const want = (await queryRows<{ v: string }>(ch, c.sql))[0]?.v ?? "0";
    for (;;) {
      const r = await cubeLoad(cubeUrl, token, {
        measures: [c.member],
        timeDimensions: [
          { dimension: c.timeMember, dateRange: ["2000-01-01T00:00:00.000", "2099-12-31T23:59:59.999"] },
        ],
        cache: "must-revalidate",
      });
      const got = String(r.data[0]?.[c.member] ?? "0");
      if (got === want) break;
      if (Date.now() - t0 > timeoutMs)
        throw new Error(`rollup ${c.rollup} (${c.member}) did not settle: cube=${got} clickhouse=${want}`);
      await new Promise((res) => setTimeout(res, 700));
    }
  }
  return Date.now() - t0;
}

export async function resetData(ch: ClickHouseClient): Promise<void> {
  await truncateAll(ch);
}

export async function optimizeFinal(ch: ClickHouseClient, tables: string[]): Promise<void> {
  for (const t of tables) await ch.command({ query: `OPTIMIZE TABLE ${t} FINAL` });
}

import type { ClickHouseClient } from "@clickhouse/client";
import { truncateAll } from "./load.ts";

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

export async function resetData(ch: ClickHouseClient): Promise<void> {
  await truncateAll(ch);
}

export async function optimizeFinal(ch: ClickHouseClient, tables: string[]): Promise<void> {
  for (const t of tables) await ch.command({ query: `OPTIMIZE TABLE ${t} FINAL` });
}

import { describe, expect, it, vi } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import type { Redis } from "ioredis";
import { insertLive } from "../../src/backfill/ch.ts";
import { backoffDelayMs, isTransientError, withRetry } from "../../src/rate/retry.ts";
import { heldLeaseCount, installGracefulShutdown, releaseAllLeases } from "../../src/rate/shutdown.ts";
import { RedisLease } from "../../src/rate/limiter.ts";
import { SchedulerLease } from "../../src/scheduler/lease.ts";

/** Minimal in-memory Redis: SET NX PX, GET, and the two owner-checked Lua scripts used by the leases. */
class FakeRedis {
  kv = new Map<string, string>();
  async set(k: string, v: string, _px: string, _ttl: number, nx: string) {
    if (nx === "NX" && this.kv.has(k)) return null;
    this.kv.set(k, v);
    return "OK";
  }
  async eval(script: string, _n: number, key: string, token: string) {
    if (this.kv.get(key) !== token) return 0;
    if (script.includes("DEL")) this.kv.delete(key);
    return 1;
  }
  expire(k: string) {
    this.kv.delete(k);
  }
}
const asRedis = (r: FakeRedis): Redis => r as unknown as Redis;
const timeoutErr = () => Object.assign(new Error("Timeout error."), { name: "Error" });

describe("transient error handling", () => {
  it("classifies ClickHouse/Postgres/network timeouts as transient and logic errors as not", () => {
    expect(isTransientError(timeoutErr())).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "57P01" }))).toBe(true);
    expect(isTransientError(new Error("terminating connection due to administrator command"))).toBe(true);
    expect(isTransientError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("bad"), { code: "23505" }))).toBe(false);
    expect(isTransientError(new Error("schema mismatch"))).toBe(false);
  });

  it("withRetry backs off and recovers; gives up on non-transient errors and exhausted attempts", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw timeoutErr();
        return "ok";
      },
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r).toBe("ok");
    expect(sleeps).toEqual([backoffDelayMs(1), backoffDelayMs(2)]);
    await expect(
      withRetry(async () => Promise.reject(new Error("logic")), { sleep: async () => {} }),
    ).rejects.toThrow("logic");
    let m = 0;
    await expect(
      withRetry(async () => (m++, Promise.reject(timeoutErr())), { attempts: 3, sleep: async () => {} }),
    ).rejects.toThrow("Timeout");
    expect(m).toBe(3);
  });

  it("insertLive survives injected ClickHouse timeouts without skipping or splitting a batch", async () => {
    vi.useFakeTimers();
    const calls: unknown[][] = [];
    let fail = 2;
    const ch = {
      insert: async (a: { values: unknown[] }) => {
        calls.push(a.values);
        if (fail-- > 0) throw timeoutErr();
      },
    } as unknown as ClickHouseClient;
    const rows = [
      {
        provider_id: "p",
        dataset: "d",
        from_utc: "2025-01-01",
        to_utc: "2025-01-02",
        state: "x",
        reason_code: "r",
        source_label: "LIVE",
        version: 1,
      },
    ];
    const p = insertLive(ch, "quality_gaps", rows);
    await vi.runAllTimersAsync();
    expect(await p).toBe(1);
    vi.useRealTimers();
    expect(calls).toHaveLength(3); // two timeouts, then the same batch lands
    expect(calls.every((c) => c.length === 1)).toBe(true);
  });
});

describe("scheduler lease across machine sleep", () => {
  it("a simulated clock jump with an expired key re-acquires instead of reporting lost", async () => {
    const redis = new FakeRedis();
    let now = 0;
    const events: string[] = [];
    const lease = new SchedulerLease(asRedis(redis), "k", 120_000, {
      now: () => now,
      onEvent: (e) => events.push(e),
    });
    expect(await lease.acquire()).toBe(true);
    await lease.beat(40_000);
    now += 8 * 3600_000; // laptop slept for 8 hours
    redis.expire("k"); // TTL elapsed meanwhile
    await lease.beat(40_000);
    expect(lease.lost).toBe(false);
    expect(lease.clockJumps).toBe(1);
    expect(lease.reacquisitions).toBe(1);
    expect(events).toEqual(["clock_jump", "reacquired"]);
    expect(redis.kv.get("k")).toBe(lease.token);
    await lease.release();
  });

  it("is lost only when another instance took the key while we slept", async () => {
    const redis = new FakeRedis();
    const lease = new SchedulerLease(asRedis(redis), "k", 120_000);
    await lease.acquire();
    redis.kv.set("k", "someone-else");
    await lease.beat();
    expect(lease.lost).toBe(true);
    expect(redis.kv.get("k")).toBe("someone-else");
    await lease.release(); // not the owner: leaves it alone
    expect(redis.kv.get("k")).toBe("someone-else");
  });

  it("a redis error during beat does not kill the loop or flip lost", async () => {
    const redis = new FakeRedis();
    const lease = new SchedulerLease(asRedis(redis), "k", 120_000);
    await lease.acquire();
    redis.eval = async () => {
      throw timeoutErr();
    };
    await lease.beat();
    expect(lease.lost).toBe(false);
    await lease.release().catch(() => undefined);
  });
});

describe("graceful shutdown", () => {
  it("SIGTERM stops loops and releases every held lease (scheduler and collector) before exit", async () => {
    const redis = new FakeRedis();
    const sched = new SchedulerLease(asRedis(redis), "sched", 120_000);
    const coll = new RedisLease(asRedis(redis), "collector", 600_000);
    await sched.acquire();
    await coll.acquire();
    expect(heldLeaseCount()).toBe(2);
    let stopped = false;
    let code: number | null = null;
    const done = new Promise<void>((res) => {
      const s = installGracefulShutdown({
        log: () => {},
        onStop: () => (stopped = true),
        graceMs: 20,
        signals: [],
        exit: (c) => {
          code = c;
          res();
        },
      });
      void s.trigger("SIGTERM");
    });
    expect(stopped).toBe(true);
    await done;
    expect(code).toBe(0);
    expect(redis.kv.size).toBe(0);
    expect(heldLeaseCount()).toBe(0);
    expect(await releaseAllLeases()).toBe(0);
  });
});

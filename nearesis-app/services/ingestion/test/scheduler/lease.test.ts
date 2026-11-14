import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { SchedulerLease } from "../../src/scheduler/lease.ts";

const redis = new Redis("redis://127.0.0.1:56379", { maxRetriesPerRequest: 2 });
const key = `ingestion:lease:scheduler-test-${randomBytes(6).toString("hex")}`;
afterAll(async () => {
  await redis.del(key);
  redis.disconnect();
});

describe("single-instance lease", () => {
  it("only one owner at a time; only the owner renews or releases", async () => {
    const a = new SchedulerLease(redis, key, 5000);
    const b = new SchedulerLease(redis, key, 5000);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(await b.renew()).toBe(false);
    expect(await a.renew()).toBe(true);
    await b.release(); // not the owner: must not free it
    expect(await redis.get(key)).toBe(a.token);
    await a.release();
    expect(await redis.get(key)).toBeNull();
    expect(await b.acquire()).toBe(true);
    await b.release();
  });

  it("an expired lease can be taken over and the old owner notices it lost the lease", async () => {
    const a = new SchedulerLease(redis, key, 300);
    const b = new SchedulerLease(redis, key, 5000);
    expect(await a.acquire()).toBe(true);
    a.startRenewing();
    await redis.del(key); // simulate expiry/takeover
    expect(await b.acquire()).toBe(true);
    const deadline = Date.now() + 3000;
    while (!a.lost && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(a.lost).toBe(true);
    await a.release();
    expect(await redis.get(key)).toBe(b.token);
    await b.release();
  });
});

import { describe, expect, test } from "vitest";
import { ReadCache } from "../../src/read-cache.ts";

describe("ReadCache (FND-017)", () => {
  test("reuses a read within the ttl, reloads after it, and shares one in-flight load", async () => {
    let t = 0;
    let loads = 0;
    const c = new ReadCache(1000, () => t);
    const load = async () => ++loads;
    const [a, b] = await Promise.all([c.get("k", load), c.get("k", load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    t = 999;
    expect(await c.get("k", load)).toBe(1);
    t = 1000;
    expect(await c.get("k", load)).toBe(2);
    expect(await c.get("other", load)).toBe(3);
  });
  test("never caches failures, and ttl 0 disables caching", async () => {
    const c = new ReadCache(1000, () => 0);
    let n = 0;
    await expect(
      c.get("k", async () => {
        n++;
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(await c.get("k", async () => ++n)).toBe(2);
    const off = new ReadCache(0);
    let m = 0;
    await off.get("k", async () => ++m);
    await off.get("k", async () => ++m);
    expect(m).toBe(2);
  });
  test("stays bounded", async () => {
    const c = new ReadCache(1000, () => 0, 3);
    for (let i = 0; i < 10; i++) await c.get(`k${i}`, async () => i);
    let loads = 0;
    await c.get("k9", async () => ++loads);
    expect(loads).toBe(0);
  });
});

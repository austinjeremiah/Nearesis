import { describe, expect, it } from "vitest";
import { KernelError } from "@nearesis/kernel";
import { CircuitBreaker, DegradationGuard } from "../../src/overload/index.ts";

describe("CircuitBreaker", () => {
  it("opens after the threshold, then lets exactly one probe through", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000, now: () => t });
    expect(b.allow()).toBe(true);
    b.failure();
    expect(b.state).toBe("closed");
    b.failure();
    expect(b.state).toBe("open");
    expect(b.allow()).toBe(false);
    t = 999;
    expect(b.allow()).toBe(false);
    t = 1000;
    const callers = Array.from({ length: 50 }, () => b.allow());
    expect(callers.filter(Boolean)).toHaveLength(1); // a single cautious probe
    expect(b.state).toBe("half_open");
    expect(b.probeCount).toBe(1);
    b.success();
    expect(b.state).toBe("closed");
    expect(b.allow()).toBe(true);
  });

  it("a failed probe reopens with a doubled interval, capped", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, openMs: 1000, maxOpenMs: 3000, now: () => t });
    b.failure();
    t = 1000;
    expect(b.allow()).toBe(true);
    b.failure(); // probe failed: interval 2000
    t = 2999;
    expect(b.allow()).toBe(false);
    t = 3000;
    expect(b.allow()).toBe(true);
    b.failure(); // 4000 capped at 3000
    t = 5999;
    expect(b.allow()).toBe(false);
    t = 6000;
    expect(b.allow()).toBe(true);
  });

  it("401 and 403 never get an automatic probe", () => {
    let t = 0;
    const b = new CircuitBreaker({ failureThreshold: 5, openMs: 10, now: () => t });
    b.failure(401);
    expect(b.state).toBe("open");
    expect(b.requiresIntervention).toBe(true);
    t = 1e9;
    expect(b.allow()).toBe(false);
    b.reset();
    expect(b.allow()).toBe(true);
  });
});

describe("DegradationGuard", () => {
  const wm = (h: number) => new Date(Date.UTC(2026, 10, 12, h)).toISOString();

  it("serves the last finalized snapshot with a warning, blocks current publication, and restores through one probe", async () => {
    let t = Date.UTC(2026, 10, 12, 12);
    const g = new DegradationGuard<number>({ failureThreshold: 2, openMs: 1000, now: () => t });
    let live: () => Promise<{ value: number; watermark: string; finalized: boolean }> = async () => ({
      value: 100,
      watermark: wm(10),
      finalized: true,
    });
    const first = await g.read("src", () => live());
    expect(first.serve.servedFrom).toBe("live");
    expect(first.serve.currentPublicationAllowed).toBe(true);
    expect(() => g.assertCanPublishCurrent("src")).not.toThrow();

    let calls = 0;
    live = async () => {
      calls++;
      throw new Error("503");
    };
    const a = await g.read("src", () => live());
    const b = await g.read("src", () => live()); // second failure opens the breaker
    for (const r of [a, b]) {
      expect(r.value).toBe(100);
      expect(r.serve.servedFrom).toBe("last_finalized_snapshot");
      expect(r.serve.currentPublicationAllowed).toBe(false);
      expect(r.serve.warning?.asOf).toBe(wm(10));
      expect(r.serve.warning?.staleSeconds).toBe(2 * 3600);
    }
    expect(g.breakerOf("src").state).toBe("open");
    expect(() => g.assertCanPublishCurrent("src")).toThrowError(KernelError);

    // while open, the source is not called at all
    for (let i = 0; i < 20; i++) await g.read("src", () => live());
    expect(calls).toBe(2);

    // after the interval ONE probe goes out even if 30 callers arrive together
    t += 1000;
    let probeCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    live = async () => {
      probeCalls++;
      await gate;
      return { value: 130, watermark: wm(12), finalized: true };
    };
    const burst = Array.from({ length: 30 }, () => g.read("src", () => live()));
    await new Promise((r) => setTimeout(r, 10));
    expect(probeCalls).toBe(1);
    release();
    const out = await Promise.all(burst);
    expect(out.filter((o) => o.serve.servedFrom === "live")).toHaveLength(1);
    expect(out.filter((o) => o.serve.servedFrom === "last_finalized_snapshot")).toHaveLength(29);
    expect(g.breakerOf("src").state).toBe("closed");
    expect(() => g.assertCanPublishCurrent("src")).not.toThrow();
  });

  it("a provisional read is served live but never becomes the snapshot", async () => {
    const g = new DegradationGuard<number>({ failureThreshold: 1 });
    await g.read("s", async () => ({ value: 1, watermark: wm(1), finalized: true }));
    await g.read("s", async () => ({ value: 2, watermark: wm(2), finalized: false }));
    const r = await g.read("s", async () => {
      throw new Error("down");
    });
    expect(r.value).toBe(1);
    expect(r.serve.asOf).toBe(wm(1));
  });

  it("with no finalized snapshot nothing is invented: the read fails UPSTREAM_DEGRADED", async () => {
    const g = new DegradationGuard<number>();
    await expect(
      g.read("s", async () => {
        throw new Error("down");
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_DEGRADED", reasonCode: "SOURCE_UNAVAILABLE_NO_SNAPSHOT" });
  });

  it("an external health signal blocks current publication until it is cleared", () => {
    const g = new DegradationGuard<number>({ failureThreshold: 1 });
    g.recordFinalized("s", 1, wm(1));
    g.markUnhealthy("s");
    expect(g.isDegraded("s")).toBe(true);
    expect(() => g.assertCanPublishCurrent("s")).toThrowError(KernelError);
    g.markHealthy("s");
    expect(() => g.assertCanPublishCurrent("s")).not.toThrow();
  });
});

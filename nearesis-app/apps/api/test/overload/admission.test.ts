import { describe, expect, it } from "vitest";
import { OverloadError, TenantAdmission } from "../../src/overload/index.ts";
import type { Occupancy } from "../../src/overload/index.ts";

/** A fake runtime: runs the test finishes by hand. */
function runtime() {
  const active = new Map<string, Set<string>>(); // tenant -> run ids the runtime shows as running
  const finished = new Set<string>();
  return {
    occupancy: async (tenant: string, held: string[]): Promise<Occupancy> => ({
      activeIds: [...(active.get(tenant) ?? [])],
      terminalIds: held.filter((h) => finished.has(h)),
    }),
    show(tenant: string, id: string) {
      (active.get(tenant) ?? active.set(tenant, new Set()).get(tenant)!).add(id);
    },
    finish(tenant: string, id: string) {
      active.get(tenant)?.delete(id);
      finished.add(id);
    },
  };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as OverloadError).reasonCode;

describe("TenantAdmission", () => {
  it("never admits more than the cap, however many submissions arrive at once, and refuses the overflow with a retry hint", async () => {
    const rt = runtime();
    const a = new TenantAdmission({
      ...rt,
      maxRunningPerTenant: 4,
      maxQueuedPerTenant: 10,
      queueTimeoutMs: 400,
      pollMs: 10,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, async (_, i) => {
        const t = await a.admit("t1");
        t.commit(`run-${i}`);
        rt.show("t1", `run-${i}`);
        return t;
      }),
    );
    const granted = results.filter((r) => r.status === "fulfilled").length;
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(granted).toBe(4);
    expect(refused).toHaveLength(196);
    for (const r of refused) {
      expect(r.reason).toBeInstanceOf(OverloadError);
      expect((r.reason as OverloadError).retryAfterS).toBeGreaterThanOrEqual(1);
      expect((r.reason as OverloadError).code).toBe("RATE_LIMITED");
    }
    const s = a.stats();
    expect(s.tenants.t1!.peakRunning).toBeLessThanOrEqual(4);
    expect(s.peakQueuedGlobal).toBeLessThanOrEqual(10); // the per-tenant queue bound held
    expect(s.queuedGlobal).toBe(0);
    expect(s.rejected.TENANT_QUEUE_FULL! + s.rejected.QUEUE_TIMEOUT!).toBe(196);
    a.close();
  });

  it("queues work and admits it when a run finishes, highest priority first, then arrival order", async () => {
    const rt = runtime();
    const a = new TenantAdmission({ ...rt, maxRunningPerTenant: 1, queueTimeoutMs: 5000, pollMs: 10 });
    const first = await a.admit("t1");
    first.commit("r0");
    rt.show("t1", "r0");
    const order: string[] = [];
    const wait = (label: string, priority: "high" | "normal" | "low") =>
      a.admit("t1", { priority }).then((t) => {
        order.push(label);
        t.commit(`run-${label}`);
        rt.show("t1", `run-${label}`);
        // finish it right away so the next waiter can go
        rt.finish("t1", `run-${label}`);
      });
    const ps = [
      wait("low", "low"),
      wait("normal-1", "normal"),
      wait("high", "high"),
      wait("normal-2", "normal"),
    ];
    await tick(30);
    expect(order).toEqual([]); // nothing runs while the cap is full
    expect(a.stats().tenants.t1!.queued).toBe(4);
    rt.finish("t1", "r0");
    await Promise.all(ps);
    expect(order).toEqual(["high", "normal-1", "normal-2", "low"]);
    a.close();
  });

  it("a queued submission times out with 429 and a Retry-After of at least 1 s", async () => {
    const rt = runtime();
    const a = new TenantAdmission({ ...rt, maxRunningPerTenant: 1, queueTimeoutMs: 60, pollMs: 10 });
    (await a.admit("t1")).commit("r0");
    rt.show("t1", "r0");
    const e = await a.admit("t1").then(
      () => null,
      (x: unknown) => x as OverloadError,
    );
    expect(e).toBeInstanceOf(OverloadError);
    expect(code(e)).toBe("QUEUE_TIMEOUT");
    expect(e!.retryAfterS).toBeGreaterThanOrEqual(1);
    expect(a.stats().queuedGlobal).toBe(0); // timed-out waiters leave the queue
    a.close();
  });

  it("a higher-priority arrival displaces the lowest waiter of a full queue; an equal or lower one is refused", async () => {
    const rt = runtime();
    const a = new TenantAdmission({
      ...rt,
      maxRunningPerTenant: 1,
      maxQueuedPerTenant: 2,
      queueTimeoutMs: 2000,
      pollMs: 10,
    });
    (await a.admit("t1")).commit("r0");
    rt.show("t1", "r0");
    const lowA = a.admit("t1", { priority: "low" });
    const lowB = a.admit("t1", { priority: "low" });
    const settled: string[] = [];
    void lowA.catch((e) => settled.push(`A:${code(e)}`));
    void lowB.catch((e) => settled.push(`B:${code(e)}`));
    await expect(a.admit("t1", { priority: "low" })).rejects.toMatchObject({
      reasonCode: "TENANT_QUEUE_FULL",
    });
    const high = a.admit("t1", { priority: "high" }); // displaces the newest low (B)
    await tick(30);
    expect(settled).toEqual(["B:QUEUE_EVICTED"]);
    rt.finish("t1", "r0");
    const t = await high;
    expect(t.tenantId).toBe("t1");
    t.release();
    a.close();
    await lowA.catch(() => undefined);
  });

  it("the global queue bound holds across tenants", async () => {
    const rt = runtime();
    const a = new TenantAdmission({
      ...rt,
      maxRunningPerTenant: 1,
      maxQueuedPerTenant: 5,
      maxQueuedGlobal: 3,
      queueTimeoutMs: 2000,
      pollMs: 10,
    });
    for (const t of ["t1", "t2"]) {
      (await a.admit(t)).commit(`${t}-r0`);
      rt.show(t, `${t}-r0`);
    }
    const waiting = [a.admit("t1"), a.admit("t1"), a.admit("t2")];
    waiting.forEach((p) => void p.catch(() => undefined));
    await expect(a.admit("t2")).rejects.toMatchObject({ reasonCode: "GLOBAL_QUEUE_FULL" });
    expect(a.stats().queuedGlobal).toBe(3);
    a.close();
  });

  it("one tenant's backlog does not delay another tenant's admission", async () => {
    const rt = runtime();
    const a = new TenantAdmission({
      ...rt,
      maxRunningPerTenant: 1,
      maxQueuedPerTenant: 50,
      queueTimeoutMs: 3000,
      pollMs: 10,
    });
    (await a.admit("busy")).commit("busy-0");
    rt.show("busy", "busy-0");
    const backlog = Array.from({ length: 50 }, () => a.admit("busy"));
    backlog.forEach((p) => void p.catch(() => undefined));
    const t0 = performance.now();
    const t = await a.admit("quiet");
    expect(performance.now() - t0).toBeLessThan(100);
    t.release();
    a.close();
  });

  it("release frees the slot at once; a slot whose run never appears is forgotten after the TTL", async () => {
    const rt = runtime();
    let now = 0;
    const a = new TenantAdmission({
      ...rt,
      maxRunningPerTenant: 1,
      heldTtlMs: 1000,
      queueTimeoutMs: 5000,
      pollMs: 10,
      now: () => now,
    });
    const t = await a.admit("t1");
    t.release();
    (await a.admit("t1")).commit("ghost"); // started, but the runtime never records it
    now = 500;
    const waiting = a.admit("t1"); // the ghost still holds the only slot
    await tick(40);
    expect(a.stats().tenants.t1!.queued).toBe(1);
    now = 1500; // past the TTL: the ghost is forgotten and the waiter is admitted
    const granted = await waiting;
    expect(granted.tenantId).toBe("t1");
    a.close();
  });
});

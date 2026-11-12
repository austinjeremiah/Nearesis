import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../../workflow/src/db.ts";
import {
  BURN_RULES,
  COST_DIMENSIONS,
  CostBlockedError,
  CostGovernor,
  SLOS,
  SloRecorder,
  decideAlert,
  evaluateAndAlert,
  evaluateRule,
  exportLedger,
  project,
  readBurn,
  resumeWorkspace,
  sloById,
  upsertPolicy,
  withTenant,
  type AlertPayload,
  type AlertSink,
} from "../src/index.ts";

describe("pure", () => {
  it("projection is labelled, linear and refuses to extrapolate from too little data", () => {
    const start = new Date("2026-11-01T00:00:00Z");
    const end = new Date("2026-12-01T00:00:00Z");
    const now = new Date("2026-11-11T00:00:00Z"); // 10 of 30 days
    const f = project({
      spentUsd: 10,
      entries: 50,
      periodStart: start,
      periodEnd: end,
      now,
      capUsd: 20,
      remainingUsd: 10,
      rate24hUsdPerHour: 1,
    });
    expect(f.label).toBe("projection");
    expect(f.projectedPeriodUsd).toBeCloseTo(30, 6);
    expect(f.projectedOverCap).toBe(true);
    expect(f.projectedExhaustionAt).toBe(new Date(now.getTime() + 10 * 3_600_000).toISOString());
    const early = project({
      spentUsd: 1,
      entries: 2,
      periodStart: start,
      periodEnd: end,
      now,
      capUsd: 20,
      remainingUsd: 19,
      rate24hUsdPerHour: 0,
    });
    expect(early.confidence).toBe("insufficient_data");
    expect(early.projectedPeriodUsd).toBeNull();
  });

  it("multi-window burn: both windows must exceed the factor", () => {
    const slo = sloById("api_availability"); // 99.5%: allowed error ratio 0.005
    const page = BURN_RULES[0]!; // 1h/5m at 14.4x => error ratio >= 7.2%
    const both = evaluateRule(slo, page, {
      long: { good: 900, total: 1000 },
      short: { good: 80, total: 100 },
    });
    expect(both.firing).toBe(true);
    expect(both.long.burnRate).toBeCloseTo(20, 6);
    // brief spike: short window burning, the hour is fine => no page
    const spike = evaluateRule(slo, page, {
      long: { good: 995, total: 1000 },
      short: { good: 0, total: 10 },
    });
    expect(spike.firing).toBe(false);
    // old incident: hour still burning but the last 5 minutes are clean => recovered, no page
    const over = evaluateRule(slo, page, {
      long: { good: 900, total: 1000 },
      short: { good: 100, total: 100 },
    });
    expect(over.firing).toBe(false);
    // no events is no data, never an alert
    expect(
      evaluateRule(slo, page, { long: { good: 0, total: 0 }, short: { good: 0, total: 0 } }).firing,
    ).toBe(false);
  });

  it("declares every SLO with an objective in (0,1)", () => {
    for (const s of SLOS) expect(s.objective > 0 && s.objective < 1).toBe(true);
  });
});

describe("database", () => {
  let db: TestDatabase;
  const sent: AlertPayload[] = [];
  const sink: AlertSink = { send: async (a) => void sent.push(a) };
  const clock = new Date("2026-11-12T10:00:00Z");
  let gov: CostGovernor;
  const tenant = randomUUID();
  const ws = randomUUID();
  beforeAll(async () => {
    db = await createTestDatabase();
    gov = new CostGovernor({ pool: db.app, sink, clock: () => clock });
  }, 120_000);
  afterAll(async () => db?.drop());

  it("blocks BEFORE execution at the cap, records the block, hard-stops, and resume clears it", async () => {
    await withTenant(db.app, tenant, (c) =>
      upsertPolicy(
        c,
        tenant,
        ws,
        {
          capUsd: 1,
          inflightAllowanceUsd: 0.05,
          rates: { ai_tokens: 0.001 },
          periodStart: "2026-11-01T00:00:00Z",
        },
        clock,
      ),
    );
    let ran = 0;
    const spend = (key: string, qty: number) =>
      gov.spend(
        {
          tenantId: tenant,
          workspaceId: ws,
          key,
          dimension: "ai_tokens",
          quantity: qty,
          paidOp: "inference",
        },
        async () => {
          ran++;
          return { result: key, quantity: qty };
        },
      );
    await spend("a", 400); // 0.4
    await spend("b", 400); // 0.8
    await expect(spend("c", 400)).rejects.toBeInstanceOf(CostBlockedError); // 1.2 > 1
    expect(ran).toBe(2); // the provider call never happened for "c"
    await expect(spend("d", 1)).rejects.toMatchObject({ costReason: "HARD_STOPPED" });
    const burn = await withTenant(db.app, tenant, (c) => readBurn(c, tenant, ws, clock));
    expect(burn.spentUsd).toBeCloseTo(0.8, 9);
    expect(burn.spentUsd).toBeLessThanOrEqual(1 + 0.05);
    expect(burn.hardStopped).toBe(true);
    expect(burn.blocks.total).toBe(2);
    expect(burn.forecast.label).toBe("projection");
    expect(burn.dimensions).toHaveLength(COST_DIMENSIONS.length);
    expect(burn.dimensions.find((d) => d.dimension === "ai_tokens")!.quantity).toBe(800);
    expect(burn.dimensions.find((d) => d.dimension === "bigquery_bytes_billed")!.quantity).toBeNull();
    await withTenant(db.app, tenant, (c) => resumeWorkspace(c, tenant, ws, clock));
    await spend("e", 100); // cap not changed, 0.9 <= 1 => allowed again
    const led = await withTenant(db.app, tenant, (c) => exportLedger(c, tenant, ws));
    expect(led.blocks.map((b) => b.reason).sort()).toEqual(["CAP_REACHED", "HARD_STOPPED"]);
  });

  it("denies a paid operation without permission and a dimension past its limit", async () => {
    const w2 = randomUUID();
    await withTenant(db.app, tenant, (c) =>
      upsertPolicy(
        c,
        tenant,
        w2,
        {
          capUsd: 100,
          dimensionLimits: { bigquery_bytes_billed: 1000 },
          paidOpsPermitted: [],
          periodStart: "2026-11-01T00:00:00Z",
        },
        clock,
      ),
    );
    await expect(
      gov.authorize({
        tenantId: tenant,
        workspaceId: w2,
        key: "p1",
        dimension: "outlayer_compute",
        quantity: 1,
        usd: 0.1,
        paidOp: "outlayer_job",
      }),
    ).rejects.toMatchObject({ costReason: "PAID_OP_NOT_PERMITTED" });
    await gov.authorize({
      tenantId: tenant,
      workspaceId: w2,
      key: "q1",
      dimension: "bigquery_bytes_billed",
      quantity: 900,
    });
    await expect(
      gov.authorize({
        tenantId: tenant,
        workspaceId: w2,
        key: "q2",
        dimension: "bigquery_bytes_billed",
        quantity: 200,
      }),
    ).rejects.toMatchObject({ costReason: "DIMENSION_LIMIT" });
  });

  it("caps alert frequency per window and counts the rest as suppressed", async () => {
    const t2 = randomUUID();
    const w = randomUUID();
    const caps = { maxPerWindow: 3, windowSeconds: 3600, cooldownSeconds: 0 };
    const n = { sent: 0, suppressed: 0 };
    for (let i = 0; i < 200; i++) {
      const r = await withTenant(db.app, t2, (c) =>
        decideAlert(
          c,
          {
            tenantId: t2,
            workspaceId: w,
            key: `k${i % 20}`,
            kind: "x",
            severity: "warning",
            title: "t",
            detail: {},
          },
          caps,
          clock,
        ),
      );
      n[r.status]++;
    }
    expect(n.sent).toBe(3);
    expect(n.suppressed).toBe(197);
  });

  it("SLO: a sustained outage pages once; a healthy hour does not", async () => {
    const slo = SLOS.find((s) => s.id === "api_availability")!;
    const now = new Date("2026-11-12T12:00:00Z");
    const rec = new SloRecorder(db.app, () => now);
    for (let m = 60; m > 5; m--)
      rec.record("api_availability", 1000, 1000, new Date(now.getTime() - m * 60_000));
    await rec.flush();
    const healthy = await evaluateAndAlert(db.app, undefined, now, { slos: [slo] });
    expect(healthy.statuses[0]!.firing).toHaveLength(0);
    for (let m = 5; m >= 0; m--)
      rec.record("api_availability", 100, 1000, new Date(now.getTime() - m * 60_000)); // 90% errors
    await rec.flush();
    const got: AlertPayload[] = [];
    const bad = await evaluateAndAlert(db.app, { send: async (a) => void got.push(a) }, now, { slos: [slo] });
    expect(bad.statuses[0]!.firing.length).toBeGreaterThanOrEqual(1);
    expect(bad.sent).toBeGreaterThanOrEqual(1);
    expect(got[0]!.kind).toBe("slo.burn");
    const again = await evaluateAndAlert(db.app, undefined, now, { slos: [slo] });
    expect(again.sent).toBe(0); // same alert key inside the window is a duplicate
    expect(again.suppressed).toBeGreaterThanOrEqual(1);
  });
});

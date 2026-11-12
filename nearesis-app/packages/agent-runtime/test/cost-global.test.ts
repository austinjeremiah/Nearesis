import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GlobalReconciliation,
  GlobalSpendStatus,
  LedgerExport,
  WorkspaceBurn,
  WorkspaceReconciliation,
} from "@nearesis/contracts";
import { createTestDatabase, type TestDatabase } from "../../workflow/src/db.ts";
import {
  CostBlockedError,
  CostGovernor,
  MODEL_SPEND_CEILING_USD,
  exportLedger,
  readBurn,
  readGlobalSpend,
  reconcileGlobal,
  reconcileWorkspace,
  setGlobalPolicy,
  upsertPolicy,
  withTenant,
  type AlertPayload,
  type AlertSink,
} from "../src/index.ts";

/**
 * final_master_prompt s18: ONE global USD 5 model-spend ceiling across every workspace, unknown prices never recorded as 0,
 * reservations -> actual charges -> reconciliation. Real Postgres, real CostGovernor, no provider is ever called.
 */
let db: TestDatabase;
const sent: AlertPayload[] = [];
const sink: AlertSink = { send: async (a) => void sent.push(a) };
let t0 = new Date("2026-11-13T10:00:00Z");
const clock = () => t0;
let gov: CostGovernor;

beforeAll(async () => {
  db = await createTestDatabase();
  gov = new CostGovernor({ pool: db.app, sink, clock });
}, 120_000);
afterAll(async () => db?.drop());

const resetGlobal = async () => {
  await db.admin.query("DELETE FROM runtime.cost_global_model_spend");
  await db.admin.query("UPDATE runtime.cost_global_policy SET model_ceiling_usd = 5 WHERE id = 1");
  await db.admin.query("DELETE FROM runtime.ops_alerts");
  sent.length = 0;
};
const mkWs = async (capUsd = 1000, extra: Record<string, unknown> = {}) => {
  const tenant = randomUUID();
  const ws = randomUUID();
  await withTenant(db.app, tenant, (c) => upsertPolicy(c, tenant, ws, { capUsd, ...extra }, t0));
  return { tenant, ws };
};
const model = (w: { tenant: string; ws: string }, key: string, usd?: number) => ({
  tenantId: w.tenant,
  workspaceId: w.ws,
  key,
  dimension: "ai_tokens" as const,
  quantity: 1000,
  ...(usd !== undefined ? { usd } : {}),
});
const blockedReason = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof CostBlockedError) return e.costReason;
    throw e;
  }
};

describe("one global USD 5 model-spend ceiling", () => {
  it("is exhausted by two workspaces of different tenants together, not per workspace", async () => {
    await resetGlobal();
    const A = await mkWs(); // each workspace has a USD 1000 cap: only the global ceiling can stop them
    const B = await mkWs();
    await gov.authorize(model(A, "g-a1", 3));
    await gov.settle(A.tenant, "g-a1", { quantity: 1000, usd: 3 });
    await gov.authorize(model(B, "g-b1", 1.9));
    await gov.settle(B.tenant, "g-b1", { quantity: 1000, usd: 1.9 });
    // 4.9 committed: workspace A alone is at 3 and B at 1.9, so neither is near a per-workspace USD 5
    expect(await blockedReason(gov.authorize(model(A, "g-a2", 0.2)))).toBe("GLOBAL_CEILING");
    expect(await blockedReason(gov.authorize(model(B, "g-b2", 0.2)))).toBe("GLOBAL_CEILING");
    await gov.authorize(model(B, "g-b3", 0.1)); // exactly the remaining USD 0.1 fits
    expect(await blockedReason(gov.authorize(model(A, "g-a3", 0.000001)))).toBe("GLOBAL_CEILING");

    const g = await withTenant(db.app, A.tenant, (c) => readGlobalSpend(c, t0));
    expect(g.ceilingUsd).toBe(5);
    expect(g.committedUsd).toBeCloseTo(5, 9);
    expect(g.state).toBe("exhausted");
    expect(g.remainingUsd).toBeCloseTo(0, 9);
    // the block is recorded against the refused workspace with the global scope, and neither workspace is hard-stopped
    const la = await withTenant(db.app, A.tenant, (c) => exportLedger(c, A.tenant, A.ws));
    expect(la.blocks.map((b) => b.reason)).toContain("GLOBAL_CEILING");
    const burnA = await withTenant(db.app, A.tenant, (c) => readBurn(c, A.tenant, A.ws, t0));
    expect(burnA.hardStopped).toBe(false);
    // historical read-only operations stay available at exhaustion
    expect(burnA.spentUsd).toBeCloseTo(3, 9);
    // a non-model dimension is not affected by the model ceiling
    await gov.authorize({
      tenantId: A.tenant,
      workspaceId: A.ws,
      key: "g-a-http",
      dimension: "external_requests",
      quantity: 1,
      usd: 0.001,
    });
  });

  it("a released reservation returns its share of the ceiling", async () => {
    await resetGlobal();
    const A = await mkWs();
    const B = await mkWs();
    await gov.authorize(model(A, "r-a1", 4.5));
    expect(await blockedReason(gov.authorize(model(B, "r-b1", 1)))).toBe("GLOBAL_CEILING");
    await gov.release(A.tenant, "r-a1");
    await gov.authorize(model(B, "r-b1", 1));
  });

  it("serialises concurrent authorisations from many workspaces: never more than USD 5 is committed", async () => {
    await resetGlobal();
    const wss = await Promise.all(Array.from({ length: 6 }, () => mkWs()));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => blockedReason(gov.authorize(model(wss[i % 6]!, `c-${i}`, 1)))),
    );
    expect(results.filter((r) => r === null)).toHaveLength(5);
    expect(results.filter((r) => r === "GLOBAL_CEILING")).toHaveLength(7);
    const g = await withTenant(db.app, wss[0]!.tenant, (c) => readGlobalSpend(c, t0));
    expect(g.committedUsd).toBeLessThanOrEqual(5 + 1e-9);
  });

  it("counts model spend recorded outside the ledger (the inference spend file)", async () => {
    await resetGlobal();
    const ext = new CostGovernor({ pool: db.app, sink, clock, externalModelSpend: async () => 4.5 });
    const A = await mkWs();
    expect(await blockedReason(ext.authorize(model(A, "e-1", 0.6)))).toBe("GLOBAL_CEILING");
    await ext.authorize(model(A, "e-2", 0.5));
    const g = await withTenant(db.app, A.tenant, (c) => readGlobalSpend(c, t0, async () => 4.5));
    expect(g.externalUsd).toBe(4.5);
    expect(g.committedUsd).toBeCloseTo(5, 9);
  });

  it("observed model spend cannot be refused but counts against every later authorisation", async () => {
    await resetGlobal();
    const A = await mkWs();
    const B = await mkWs();
    await gov.observed(model(A, "o-1", 4.9));
    expect(await blockedReason(gov.authorize(model(B, "o-2", 0.2)))).toBe("GLOBAL_CEILING");
  });

  it("the owner can lower the ceiling but never raise it above USD 5", async () => {
    await resetGlobal();
    expect(MODEL_SPEND_CEILING_USD).toBe(5);
    await expect(
      withTenant(db.app, randomUUID(), (c) => setGlobalPolicy(c, { modelCeilingUsd: 6 }, t0)),
    ).rejects.toThrow(/above the authorised/);
    await expect(
      db.app.query("UPDATE runtime.cost_global_policy SET model_ceiling_usd = 6 WHERE id = 1"),
    ).rejects.toThrow(/check constraint/);
    const p = await withTenant(db.app, randomUUID(), (c) => setGlobalPolicy(c, { modelCeilingUsd: 1 }, t0));
    expect(p.modelCeilingUsd).toBe(1);
    const A = await mkWs();
    expect(await blockedReason(gov.authorize(model(A, "l-1", 1.5)))).toBe("GLOBAL_CEILING");
    await gov.authorize(model(A, "l-2", 1));
  });

  it("notifies at the configured thresholds of the global ceiling, once each", async () => {
    await resetGlobal();
    const A = await mkWs();
    await gov.authorize(model(A, "n-1", 2.6)); // 52%
    await gov.authorize(model(A, "n-2", 1.5)); // 82%
    await gov.authorize(model(A, "n-3", 0.7)); // 96%
    await gov.authorize(model(A, "n-4", 0.2)); // 100%
    const th = sent.filter((a) => a.kind === "cost.global_threshold").map((a) => a.detail.threshold);
    expect(th).toEqual([0.5, 0.8, 0.95, 1]);
    expect(sent.find((a) => a.kind === "cost.global_threshold")?.tenantId).toBeNull();
  });

  it("the global forecast states its assumptions and refuses to extrapolate from too little data", async () => {
    await resetGlobal();
    const A = await mkWs();
    await gov.authorize(model(A, "f-1", 0.1));
    const few = await withTenant(db.app, A.tenant, (c) => readGlobalSpend(c, t0));
    expect(few.forecast.confidence).toBe("insufficient_data");
    expect(few.forecast.projectedExhaustionAt).toBeNull();
    await gov.authorize(model(A, "f-2", 0.1));
    await gov.authorize(model(A, "f-3", 0.1));
    const ok = await withTenant(db.app, A.tenant, (c) => readGlobalSpend(c, t0));
    expect(ok.forecast.confidence).toBe("ok");
    expect(ok.forecast.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(ok.forecast.projectedExhaustionAt).not.toBeNull();
  });
});

describe("unknown price is never recorded as 0", () => {
  it("blocks model spend with no price (no policy and with a policy)", async () => {
    await resetGlobal();
    const A = await mkWs();
    expect(await blockedReason(gov.authorize(model(A, "u-1")))).toBe("PRICE_UNKNOWN");
    const noPolicy = { tenant: randomUUID(), ws: randomUUID() };
    expect(await blockedReason(gov.authorize(model(noPolicy, "u-2")))).toBe("PRICE_UNKNOWN");
    const l = await withTenant(db.app, A.tenant, (c) => exportLedger(c, A.tenant, A.ws));
    expect(l.entries).toHaveLength(0); // no zero-cost row was written
    expect(l.blocks[0]?.reason).toBe("PRICE_UNKNOWN");
    expect(l.blocks[0]?.requestedUsd).toBeNull();
    const g = await withTenant(db.app, A.tenant, (c) => readGlobalSpend(c, t0));
    expect(g.committedUsd).toBe(0);
  });

  it("a configured rate prices the spend; an explicit usd always wins", async () => {
    await resetGlobal();
    const A = await mkWs(1000, { rates: { ai_tokens: 0.000002 } });
    const r = await gov.authorize(model(A, "p-1"));
    expect(r.usd).toBeCloseTo(0.002, 9);
    expect(r.priceUnknown).toBe(false);
  });

  it("blocks the dimensions the owner lists in requirePriceFor, and records every other unpriced spend as unknown", async () => {
    const A = await mkWs(1000, {
      paidOpsPermitted: ["inference", "paid_api"],
      requirePriceFor: ["bigquery_bytes_billed", "external_requests"],
    });
    expect(
      await blockedReason(
        gov.authorize({
          tenantId: A.tenant,
          workspaceId: A.ws,
          key: "bq-1",
          dimension: "bigquery_bytes_billed",
          quantity: 1e9,
        }),
      ),
    ).toBe("PRICE_UNKNOWN");
    expect(
      await blockedReason(
        gov.authorize({
          tenantId: A.tenant,
          workspaceId: A.ws,
          key: "paid-1",
          dimension: "external_requests",
          quantity: 1,
          paidOp: "paid_api",
        }),
      ),
    ).toBe("PRICE_UNKNOWN");
    const res = await gov.authorize({
      tenantId: A.tenant,
      workspaceId: A.ws,
      key: "free-1",
      dimension: "clickhouse_cpu",
      quantity: 500,
    });
    expect(res.usd).toBeNull();
    expect(res.priceUnknown).toBe(true);
    await gov.settle(A.tenant, "free-1", { quantity: 700 });
    await gov.observed({
      tenantId: A.tenant,
      workspaceId: A.ws,
      key: "free-obs",
      dimension: "clickhouse_io",
      quantity: 9000,
    });
    const l = await withTenant(db.app, A.tenant, (c) => exportLedger(c, A.tenant, A.ws));
    const free = l.entries.filter((e) => e.key.startsWith("free"));
    expect(free).toHaveLength(2);
    for (const e of free) {
      expect(e.usd).toBeNull();
      expect(e.priceUnknown).toBe(true);
    }
    const raw = await db.admin.query(
      "SELECT usd, price_unknown FROM runtime.cost_ledger WHERE entry_key IN ('free-1','free-obs')",
    );
    expect(raw.rows.every((x) => x.usd === null && x.price_unknown === true)).toBe(true);
    const burn = await withTenant(db.app, A.tenant, (c) => readBurn(c, A.tenant, A.ws, t0));
    expect(burn.priceUnknown.entries).toBe(2);
    expect(burn.spentUsd).toBe(0); // not "0 USD spent": the forecast says why
    expect(burn.forecast.assumptions.join(" ")).toMatch(/unknown price/);
  });

  it("the database refuses a priceless entry that is not flagged", async () => {
    await expect(
      db.admin.query(
        `INSERT INTO runtime.cost_ledger (tenant_id, workspace_id, entry_key, dimension, quantity, usd, state)
         VALUES ($1,$2,'bad-1','external_requests',1,NULL,'settled')`,
        [randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/cost_ledger_price_known/);
  });

  it("settling with an unknown actual price keeps the reservation estimate, flagged, never 0", async () => {
    await resetGlobal();
    const A = await mkWs(1000, { rates: { ai_tokens: 0.000001 } });
    await gov.authorize(model(A, "s-1", 0.5));
    // a call-site that has a quantity but its own price is undefined falls back to the configured rate
    const s = await gov.settle(A.tenant, "s-1", { quantity: 100_000 });
    expect(s.usd).toBeCloseTo(0.1, 9);
    expect(s.priceUnknown).toBe(false);
    const B = await mkWs(1000);
    await gov.authorize({ ...model(B, "s-2", 0.4) });
    const s2 = await gov.settle(B.tenant, "s-2", { quantity: 1 }); // no rate and no usd: price now unknown
    expect(s2.priceUnknown).toBe(true);
    expect(s2.usd).toBe(0.4);
    const g = await withTenant(db.app, B.tenant, (c) => readGlobalSpend(c, t0));
    expect(g.unknownPriceEntries).toBe(1);
  });
});

describe("reservations -> actual charges -> reconciliation", () => {
  it("reports estimate vs actual, stale reservations and mirror agreement; flags a tampered mirror", async () => {
    await resetGlobal();
    const A = await mkWs(1000, { inflightAllowanceUsd: 1 });
    const saved = t0;
    t0 = new Date("2026-11-13T10:00:00Z");
    await gov.authorize(model(A, "rc-1", 1));
    await gov.settle(A.tenant, "rc-1", { quantity: 1000, usd: 1.2 }); // actual above the estimate
    await gov.authorize(model(A, "rc-2", 0.5));
    await gov.settle(A.tenant, "rc-2", { quantity: 1000, usd: 0.4 });
    await gov.authorize(model(A, "rc-3", 0.3));
    await gov.release(A.tenant, "rc-3");
    await gov.authorize(model(A, "rc-4", 0.2)); // never settled
    t0 = new Date("2026-11-14T12:00:00Z"); // 26h later

    const rep = await withTenant(db.app, A.tenant, (c) => reconcileWorkspace(c, A.tenant, A.ws, t0));
    const d = rep.dimensions.find((x) => x.dimension === "ai_tokens")!;
    expect(d.settled).toEqual({ entries: 2, usd: expect.closeTo(1.6, 9) });
    expect(d.released.entries).toBe(1);
    expect(d.reserved.entries).toBe(1);
    expect(d.estimateVsActual.estimatedUsd).toBeCloseTo(1.5, 9);
    expect(d.estimateVsActual.actualUsd).toBeCloseTo(1.6, 9);
    expect(d.estimateVsActual.varianceUsd).toBeCloseTo(0.1, 9);
    expect(rep.staleReservations.map((s) => s.key)).toEqual(["rc-4"]);
    expect(rep.globalMirror?.checked).toBe(4);
    expect(rep.globalMirror?.mismatches).toEqual([]);
    expect(rep.reconciled).toBe(false); // the stale reservation is a finding

    await gov.release(A.tenant, "rc-4");
    const clean = await withTenant(db.app, A.tenant, (c) => reconcileWorkspace(c, A.tenant, A.ws, t0));
    expect(clean.reconciled).toBe(true);
    expect(clean.discrepancies).toEqual([]);

    await db.admin.query("UPDATE runtime.cost_global_model_spend SET usd = 0.01 WHERE entry_key = 'rc-1'");
    const bad = await withTenant(db.app, A.tenant, (c) => reconcileWorkspace(c, A.tenant, A.ws, t0));
    expect(bad.reconciled).toBe(false);
    expect(bad.globalMirror?.mismatches[0]?.key).toBe("rc-1");
    t0 = saved;
  });

  it("global reconciliation lists stale reservations and over-ceiling observed spend", async () => {
    await resetGlobal();
    const A = await mkWs();
    t0 = new Date("2026-11-13T10:00:00Z");
    await gov.authorize(model(A, "gr-1", 1));
    await gov.observed(model(A, "gr-2", 4.5)); // observed spend cannot be refused: now over the ceiling
    t0 = new Date("2026-11-15T10:00:00Z");
    const rep = await withTenant(db.app, A.tenant, (c) => reconcileGlobal(c, t0));
    expect(rep.staleReservations.map((s) => s.key)).toEqual(["gr-1"]);
    expect(rep.discrepancies.some((x) => /above the ceiling/.test(x))).toBe(true);
    expect(rep.reconciled).toBe(false);
    t0 = new Date("2026-11-13T10:00:00Z");
  });
});

describe("the published OpenAPI response contracts match the real cost output", () => {
  it("readBurn, exportLedger, reconcileWorkspace, readGlobalSpend and reconcileGlobal parse against packages/contracts/src/openapi-cost.ts", async () => {
    await resetGlobal();
    const A = await mkWs(1000, {
      inflightAllowanceUsd: 1,
      rates: { ai_tokens: 0.000002 },
      dimensionLimits: { clickhouse_io: 1e9 },
    });
    await gov.authorize(model(A, "k-1"));
    await gov.settle(A.tenant, "k-1", { quantity: 2000 });
    await gov.authorize({
      tenantId: A.tenant,
      workspaceId: A.ws,
      key: "k-2",
      dimension: "clickhouse_cpu",
      quantity: 5,
    });
    await gov.settle(A.tenant, "k-2", { quantity: 6 });
    expect(await blockedReason(gov.authorize(model(A, "k-3", 99999)))).toBe("GLOBAL_CEILING");
    const now = new Date(t0.getTime() + 3_600_000 * 3);
    const out = await withTenant(db.app, A.tenant, async (c) => ({
      burn: await readBurn(c, A.tenant, A.ws, now),
      ledger: await exportLedger(c, A.tenant, A.ws),
      rec: await reconcileWorkspace(c, A.tenant, A.ws, now),
      glob: await readGlobalSpend(c, now),
      grec: await reconcileGlobal(c, now),
    }));
    for (const [name, schema, v] of [
      ["burn", WorkspaceBurn, out.burn],
      ["ledger", LedgerExport, out.ledger],
      ["workspace reconciliation", WorkspaceReconciliation, out.rec],
      ["global", GlobalSpendStatus, out.glob],
      ["global reconciliation", GlobalReconciliation, out.grec],
    ] as const) {
      const r = schema.safeParse(JSON.parse(JSON.stringify(v)));
      expect(r.success, `${name}: ${JSON.stringify(r.error?.issues.slice(0, 3))}`).toBe(true);
    }
  });
});

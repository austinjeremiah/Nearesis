import { describe, expect, it } from "vitest";
import {
  AnalyticsOutcome,
  ANALYTICS_CERTIFICATION,
  ANALYTICS_LIMITS,
  type AnalyticsCapabilityId,
} from "@nearesis/contracts";
import {
  panelDataOf,
  runAnalytics,
  type AccountDataSource,
  type AccountDay,
  type AnalyticsDeps,
  type EntityDataSource,
  IntentsAnalytics,
  type IntentsResult,
} from "../../src/index.ts";

const NOW = new Date("2026-11-13T00:00:00Z");
const cov = (from: string, to: string, missing: string[] = []) => ({
  dataset: "intents_swaps" as const,
  source: "NEAR Intents Explorer API (1Click transactions)" as const,
  scopeNote: "scope",
  window: { from, to },
  daysInWindow: 14,
  completeDays: 14 - missing.length,
  incompleteDays: [],
  missingDays: missing,
  swapRows: 1000,
  usdUnknownRows: 0,
  usdKnownShare: "1",
  eraSplit: {},
  privateSettlementNote: "n",
});
const prov = {
  source: "s",
  tables: ["nearesis_live.intents_swaps"],
  asOf: "2026-11-12",
  computedAt: NOW.toISOString(),
  metricVersion: "intents-1.0.0",
  method: "m",
};
const okResult = <T>(metric: string, data: T, missing: string[] = []): IntentsResult<T> => ({
  status: "OK",
  metric,
  definition: "d",
  window: { from: "2026-10-30", to: "2026-11-12" },
  chart: { kind: "bar" },
  data,
  coverage: cov("2026-10-30", "2026-11-12", missing),
  provenance: prov,
  caveats: [],
});

// 2026-11-02 and 2026-11-09 are Mondays
const DAILY = [
  {
    day: "2026-11-02",
    status: "SUCCESS",
    swaps: 90,
    share: "0.9",
    volumeUsdKnown: "900.5",
    swapsWithUnknownUsd: 0,
  },
  {
    day: "2026-11-02",
    status: "REFUNDED",
    swaps: 10,
    share: "0.1",
    volumeUsdKnown: null,
    swapsWithUnknownUsd: 0,
  },
  {
    day: "2026-11-03",
    status: "SUCCESS",
    swaps: 50,
    share: "0.8333",
    volumeUsdKnown: "100.25",
    swapsWithUnknownUsd: 0,
  },
  {
    day: "2026-11-03",
    status: "REFUNDED",
    swaps: 10,
    share: "0.1667",
    volumeUsdKnown: null,
    swapsWithUnknownUsd: 0,
  },
  {
    day: "2026-11-09",
    status: "SUCCESS",
    swaps: 40,
    share: "0.8",
    volumeUsdKnown: "10",
    swapsWithUnknownUsd: 0,
  },
  {
    day: "2026-11-09",
    status: "REFUNDED",
    swaps: 10,
    share: "0.2",
    volumeUsdKnown: null,
    swapsWithUnknownUsd: 0,
  },
];
const calls: string[] = [];
const intents = {
  defaultWindow: async () => ({ from: "2026-10-30", to: "2026-11-12" }),
  statusDistribution: async (w: unknown, by: string) => {
    calls.push(`status:${by}`);
    return okResult("intents.status_distribution", DAILY);
  },
  trend: async () =>
    okResult("intents.trend", [
      {
        period: "2026-11-02",
        swaps: 160,
        success: 140,
        refunded: 20,
        refundRate: "0.125",
        volumeUsdKnown: "1000.75",
        swapsWithUnknownUsd: 0,
        days: 2,
      },
    ]),
  refundCauses: async () =>
    okResult(
      "intents.refund_causes",
      [
        {
          period: "2026-11-02",
          reason: "AMOUNT_MORE_THAN_BALANCE",
          refunded: 20,
          share: "1",
          refundedUsd: null,
          swapsWithUnknownUsd: 0,
        },
      ],
      ["2026-11-05"],
    ),
  solverMetrics: async () => ({
    status: "CANNOT_COMPUTE" as const,
    metric: "intents.solver_metrics",
    missing: ["solver_id"],
    explanation: "no solver identity",
    evidence: ["doc"],
    coverage: null,
    provenance: prov,
  }),
  settlementDuration: async () => ({
    status: "CANNOT_COMPUTE" as const,
    metric: "intents.settlement_duration",
    missing: ["settled_at"],
    explanation: "one timestamp",
    evidence: [],
    alternative: {
      metric: "intents.quoted_time_estimate_by_origin_chain",
      label: "INDICATIVE",
      data: [{ originChain: "eth", quotes: 5, p50Seconds: "12", p95Seconds: "30" }],
    },
    coverage: cov("2026-10-30", "2026-11-12"),
    provenance: prov,
  }),
  fieldInventory: () => new IntentsAnalytics(null as never).fieldInventory(),
} as unknown as IntentsAnalytics;

const emptyEntities: EntityDataSource = {
  registry: async () => ({ registryVersion: "none", entities: [], mappings: [], relations: [] }),
  activity: async () => ({ receivers: [], remainder: [] }),
  latestDate: async () => null,
};
const day = (date: string, active: number): AccountDay =>
  ({
    date,
    signersAll: active,
    txAll: 100,
    txIntents: 0,
    txBridge: 0,
    signersWithIntents: 0,
    signersOrganic: active,
    txOrganic: 100,
    newSigners: 5,
    returningSigners: active - 5,
    newTx: 5,
    returningTx: 95,
    top10Tx: 10,
    top1PctSigners: 1,
    top1PctTx: 30,
    top5PctSigners: 5,
    top5PctTx: 40,
    headSigners: 2,
    headTx: 50,
    tailSigners: active - 2,
    tailTx: 50,
    headThreshold: 100,
  }) as AccountDay;
const accounts: AccountDataSource = {
  window: async () => ({
    windowStart: "2026-11-01",
    from: "2026-11-01",
    to: "2026-11-05",
    days: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-05"],
    headThreshold: 100,
  }),
  days: async (_f, _t) => [day("2026-11-02", 100), day("2026-11-03", 110), day("2026-11-05", 120)],
  retention: async () => [],
  headAccounts: async () => [],
  headDays: async () => [],
  profile: async () => null,
  entityDays: async () => [],
};
const deps = (over: Partial<AnalyticsDeps> = {}): AnalyticsDeps => ({
  intents,
  entities: emptyEntities,
  accounts,
  now: () => NOW,
  ...over,
});
const run = async (cap: AnalyticsCapabilityId, input: unknown, d = deps()) => {
  const r = await runAnalytics(d, cap, input);
  if (!r.ok) throw new Error(`refused ${r.code}: ${r.message}`);
  expect(AnalyticsOutcome.safeParse(r.outcome).success).toBe(true); // every outcome matches the typed contract
  return r.outcome;
};

describe("agent analytics: typed outputs", () => {
  it("status per week folds Monday-start weeks, recomputes shares and labels the result ANALYTICS_RESULT", async () => {
    const o = await run("intents.analyze@1", {
      analysis: "status",
      from: "2026-11-02",
      to: "2026-11-15",
      grain: "week",
    });
    if (o.outcome !== "OK") throw new Error("expected OK");
    expect(o.label).toBe("ANALYTICS_RESULT");
    expect(o.certification).toBe(ANALYTICS_CERTIFICATION);
    expect(o.table.columns.map((c) => c.name)).toEqual([
      "week",
      "status",
      "swaps",
      "share",
      "settledVolumeUsd",
      "swapsWithUnknownUsd",
    ]);
    expect(o.table.rows).toEqual([
      ["2026-11-02", "SUCCESS", 140, 0.875, 1000.75, 0],
      ["2026-11-02", "REFUNDED", 20, 0.125, null, 0],
      ["2026-11-09", "SUCCESS", 40, 0.8, 10, 0],
      ["2026-11-09", "REFUNDED", 10, 0.2, null, 0],
    ]);
    expect(o.chart).toEqual({ kind: "stacked_bar", x: "week", y: ["swaps"], series: "status" });
    expect(calls).toContain("status:day"); // weeks are folded from daily rows, not guessed
    expect(o.provenance.tables).toEqual(["nearesis_live.intents_swaps"]);
    expect(o.call.input).toMatchObject({
      analysis: "status",
      from: "2026-11-02",
      to: "2026-11-15",
      grain: "week",
    });
  });

  it("the call hash names one resolved computation: relative windows are pinned to absolute days", async () => {
    const a = await run("intents.analyze@1", { analysis: "trend", days: 14 });
    const b = await run("intents.analyze@1", { analysis: "trend", from: "2026-10-30", to: "2026-11-12" });
    expect(a.callHash).toBe(b.callHash);
    expect(a.call.input).not.toHaveProperty("days");
    const c = await run("intents.analyze@1", {
      analysis: "trend",
      from: "2026-10-30",
      to: "2026-11-12",
      granularity: "week",
    });
    expect(c.callHash).not.toBe(a.callHash);
  });

  it("coverage gaps are reported, never zero-filled", async () => {
    const o = await run("intents.analyze@1", {
      analysis: "refund_causes",
      from: "2026-10-30",
      to: "2026-11-12",
      by: "week",
    });
    expect(o.coverage.state).toBe("partial");
    expect(o.coverage.missingDays).toEqual(["2026-11-05"]);
    expect(o.coverage.note).toMatch(/never zero/);
  });

  it("CANNOT_COMPUTE passes through typed with its missing fields, evidence and labelled alternative", async () => {
    const s = await run("intents.analyze@1", { analysis: "solver_metrics", days: 7 });
    expect(s).toMatchObject({ outcome: "CANNOT_COMPUTE", missing: ["solver_id"], evidence: ["doc"] });
    const d = await run("intents.analyze@1", { analysis: "settlement_duration", days: 7 });
    if (d.outcome !== "CANNOT_COMPUTE") throw new Error("expected CANNOT_COMPUTE");
    expect(d.alternative?.label).toMatch(/INDICATIVE/);
    expect(d.alternative?.table?.rows).toEqual([["eth", 5, 12, 30]]);
    expect(panelDataOf(d).cannotCompute).toEqual({ missing: ["settled_at"], explanation: "one timestamp" });
    expect(panelDataOf(d).chart.freshness).toBe("unavailable");
  });

  it("field_inventory needs no window and answers with the documented per-concept inventory", async () => {
    const o = await run("intents.analyze@1", { analysis: "field_inventory" });
    if (o.outcome !== "OK") throw new Error("expected OK");
    expect(o.table.columns.map((c) => c.name)).toEqual(["concept", "status", "source", "note"]);
    const status = new Map(o.table.rows.map((r) => [r[0], r[1]]));
    expect(status.get("settlement time / completion time")).toBe("not_provided");
    expect(status.get("solver / relayer / market-maker identity")).toBe("not_provided");
    expect(o.table.rows.some((r) => r[1] === "not_provided")).toBe(true);
  });

  it("a source that is not loaded is CANNOT_COMPUTE, never a zero", async () => {
    const e = await run("entities.analyze@1", { analysis: "coverage", days: 30 });
    expect(e).toMatchObject({ outcome: "CANNOT_COMPUTE", missing: ["entity registry"] });
    const a = await run("accounts.analyze@1", { analysis: "daily", days: 7 }, deps({ accounts: null }));
    expect(a).toMatchObject({ outcome: "CANNOT_COMPUTE" });
    const u = await run(
      "entities.analyze@1",
      { analysis: "unique_signers", entityId: "hot", days: 7 },
      deps({
        entities: {
          ...emptyEntities,
          registry: async () => ({
            registryVersion: "t",
            entities: [
              {
                entityId: "hot",
                entityType: "application",
                name: "HOT",
                categoryId: null,
                parentEntityId: null,
                description: "",
                registryVersion: "t",
              },
            ],
            mappings: [],
            relations: [],
          }),
          latestDate: async () => "2026-11-05",
        },
        accounts: null,
      }),
    );
    expect(u).toMatchObject({ outcome: "CANNOT_COMPUTE", missing: ["PER_SIGNER_SOURCE_MISSING"] });
  });

  it("accounts daily: exact counts, gaps listed as missing days, accounts are not people", async () => {
    const o = await run("accounts.analyze@1", { analysis: "daily", from: "2026-11-01", to: "2026-11-05" });
    if (o.outcome !== "OK") throw new Error("expected OK");
    expect(o.table.rows.map((r) => r[0])).toEqual(["2026-11-02", "2026-11-03", "2026-11-05"]);
    expect(o.coverage).toMatchObject({ state: "partial", daysRequested: 5, daysWithData: 3 });
    expect(o.coverage.missingDays).toEqual(["2026-11-01", "2026-11-04"]);
    expect(o.caveats.join(" ")).toMatch(/not people/);
    expect(o.chart).toMatchObject({ kind: "line", x: "date" });
  });

  it("panel data carries the ANALYTICS label, the executed call and a result hash", async () => {
    const o = await run("accounts.analyze@1", { analysis: "daily", from: "2026-11-01", to: "2026-11-05" });
    const p = panelDataOf(o);
    expect(p.provenance).toMatchObject({
      sourceLabel: "ANALYTICS",
      certification: ANALYTICS_CERTIFICATION,
      queryHash: o.callHash,
    });
    expect(p.provenance.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.chart.freshness).toBe("partial");
  });
});

describe("agent analytics: result cache", () => {
  it("serves a repeated call from memory and shares one computation between concurrent identical calls", async () => {
    let queries = 0;
    const counting = {
      ...(intents as unknown as Record<string, unknown>),
      trend: async () => {
        queries++;
        await new Promise((r) => setTimeout(r, 10));
        return (intents as unknown as { trend: () => Promise<unknown> }).trend();
      },
    } as unknown as IntentsAnalytics;
    const d = deps({ intents: counting });
    const input = { analysis: "trend", from: "2026-10-30", to: "2026-11-12", granularity: "week" };
    const [a, b] = await Promise.all([
      run("intents.analyze@1", input, d),
      run("intents.analyze@1", input, d),
    ]);
    await run("intents.analyze@1", input, d);
    expect(queries).toBe(1);
    expect(a.callHash).toBe(b.callHash);
    await run("intents.analyze@1", { ...input, granularity: "day" }, d);
    expect(queries).toBe(2); // a different call is computed
  });
  it("never remembers a failure: the next call asks the source again", async () => {
    let n = 0;
    const flaky = deps({
      accounts: {
        ...accounts,
        window: async () => {
          if (++n === 1) throw new Error("boom");
          return accounts.window();
        },
      },
    });
    expect((await runAnalytics(flaky, "accounts.analyze@1", { analysis: "coverage" })).ok).toBe(false);
    expect((await runAnalytics(flaky, "accounts.analyze@1", { analysis: "coverage" })).ok).toBe(true);
  });
});

describe("agent analytics: bounds and refusals", () => {
  it("refuses unknown analyses, unknown keys, SQL-like input and oversized windows before any query", async () => {
    const before = calls.length;
    for (const bad of [
      { analysis: "raw_sql", sql: "select 1" },
      { analysis: "status", days: 100000 },
      { analysis: "status", top: 5 },
      { analysis: "refund_rates", top: ANALYTICS_LIMITS.maxTop + 1 },
      { analysis: "status", from: "2026-13-45", to: "2026-14-01" },
    ]) {
      const r = await runAnalytics(deps(), "intents.analyze@1", bad);
      expect(r).toMatchObject({ ok: false, status: 400, code: "INVALID_INPUT" });
    }
    const wide = await runAnalytics(deps(), "intents.analyze@1", {
      analysis: "status",
      from: "2024-01-01",
      to: "2026-11-12",
    });
    expect(wide).toMatchObject({ ok: false, status: 400, code: "INVALID_WINDOW" });
    const backwards = await runAnalytics(deps(), "intents.analyze@1", {
      analysis: "status",
      from: "2026-11-12",
      to: "2026-11-01",
    });
    expect(backwards).toMatchObject({ ok: false, code: "INVALID_WINDOW" });
    expect(calls.length).toBe(before);
  });
  it("no tenant or workspace key is accepted from the input", async () => {
    for (const key of ["tenantId", "workspaceId", "orgId"]) {
      const r = await runAnalytics(deps(), "accounts.analyze@1", { analysis: "coverage", [key]: "x" });
      expect(r).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
  });
  it("an unknown entity is a typed 404, and source failures become ANALYTICS_SOURCE_UNAVAILABLE without leaking details", async () => {
    const d = deps({
      entities: {
        ...emptyEntities,
        registry: async () => ({ registryVersion: "t", entities: [], mappings: [], relations: [] }),
        latestDate: async () => "2026-11-05",
      },
    });
    expect(
      await runAnalytics(d, "entities.analyze@1", {
        analysis: "metrics",
        entityId: "nope",
        from: "2026-11-01",
        to: "2026-11-05",
      }),
    ).toMatchObject({ ok: false, status: 404, code: "ENTITY_NOT_FOUND" });
    const boom = deps({
      accounts: {
        ...accounts,
        window: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.1");
        },
      },
    });
    const r = await runAnalytics(boom, "accounts.analyze@1", { analysis: "coverage" });
    expect(r).toMatchObject({ ok: false, status: 503, code: "ANALYTICS_SOURCE_UNAVAILABLE" });
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });
});

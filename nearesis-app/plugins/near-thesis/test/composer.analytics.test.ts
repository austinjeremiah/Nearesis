/**
 * The composer with mock inference and a fake tool gateway: when the certified catalogue lacks the requested metric
 * (refunds, status) it plans typed analytics panels instead of abstaining, calls the analytics capabilities concurrently,
 * compiles ANALYTICS_RESULT panels (never "certified metric"), passes CANNOT_COMPUTE through, and skips what cannot be drawn.
 */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  ANALYSES_BY_CAPABILITY,
  PanelSpec,
  type InferenceProvider,
  type StructuredResult,
} from "@nearesis/contracts";
import { applyCanvasPatch } from "@nearesis/canvas-schema";
import { runAnalytics, type AnalyticsDeps, type IntentsAnalytics } from "@nearesis/analytics";
import { ANALYTICS_TOOLS, ComposerPlan, composeCanvas } from "../src/index.ts";

const OWNER_QUESTION = "Intents swaps by status per week since August, how have refunds changed?";
const NOW = new Date("2026-11-13T00:00:00Z");
const cov = {
  dataset: "intents_swaps" as const,
  source: "NEAR Intents Explorer API (1Click transactions)" as const,
  scopeNote: "s",
  window: { from: "2026-08-01", to: "2026-11-12" },
  daysInWindow: 104,
  completeDays: 104,
  incompleteDays: [],
  missingDays: [],
  swapRows: 5000,
  usdUnknownRows: 0,
  usdKnownShare: "1",
  eraSplit: {},
  privateSettlementNote: "n",
};
const prov = {
  source: "s",
  tables: ["nearesis_live.intents_swaps"],
  asOf: "2026-11-12",
  computedAt: NOW.toISOString(),
  metricVersion: "intents-1.0.0",
  method: "m",
};
const ok = <T>(metric: string, data: T) => ({
  status: "OK" as const,
  metric,
  definition: "d",
  window: { from: "2026-08-01", to: "2026-11-12" },
  chart: { kind: "bar" as const },
  data,
  coverage: cov,
  provenance: prov,
  caveats: [] as string[],
});
const intents = {
  defaultWindow: async () => ({ from: "2026-10-14", to: "2026-11-12" }),
  statusDistribution: async () =>
    ok("intents.status_distribution", [
      {
        day: "2026-08-03",
        status: "SUCCESS",
        swaps: 900,
        share: "0.9",
        volumeUsdKnown: "10",
        swapsWithUnknownUsd: 0,
      },
      {
        day: "2026-08-03",
        status: "REFUNDED",
        swaps: 100,
        share: "0.1",
        volumeUsdKnown: "0",
        swapsWithUnknownUsd: 0,
      },
      {
        day: "2026-08-10",
        status: "SUCCESS",
        swaps: 950,
        share: "0.95",
        volumeUsdKnown: "11",
        swapsWithUnknownUsd: 0,
      },
      {
        day: "2026-08-10",
        status: "REFUNDED",
        swaps: 50,
        share: "0.05",
        volumeUsdKnown: "0",
        swapsWithUnknownUsd: 0,
      },
    ]),
  trend: async () =>
    ok("intents.trend", [
      {
        period: "2026-08-03",
        swaps: 1000,
        success: 900,
        refunded: 100,
        refundRate: "0.1",
        volumeUsdKnown: "10",
        swapsWithUnknownUsd: 0,
        days: 7,
      },
    ]),
  solverMetrics: async () => ({
    status: "CANNOT_COMPUTE" as const,
    metric: "intents.solver_metrics",
    missing: ["solver_id"],
    explanation: "no solver identity",
    evidence: [],
    coverage: null,
    provenance: prov,
  }),
} as unknown as IntentsAnalytics;
const deps: AnalyticsDeps = {
  intents,
  entities: {
    registry: async () => ({ registryVersion: "none", entities: [], mappings: [], relations: [] }),
    activity: async () => ({ receivers: [], remainder: [] }),
    latestDate: async () => null,
  },
  accounts: null,
  now: () => NOW,
};

// the live certified catalogue of the owner's run: swap counts, no refund or status metric
const CATALOGUE = {
  ok: true,
  semanticVersion: "1.0.0",
  semanticModelHash: "h",
  metrics: [
    {
      id: "live.oneclick_swap_count",
      cubeMember: "intents_swaps_live.swap_count",
      unit: "swaps",
      visibility: "public",
      sources: ["intents-1click:intents_swaps"],
    },
    {
      id: "live.oneclick_completed_swap_count",
      cubeMember: "intents_swaps_live.completed_swap_count",
      unit: "swaps",
      visibility: "public",
      sources: ["intents-1click:intents_swaps"],
    },
  ],
  dimensions: [{ id: "intents_swaps_live.day" }],
  dataWindows: { intents_swaps: { from: "2026-04-01", to: "2026-11-12" } },
  analyticsWindows: { intents: { from: "2026-04-01", to: "2026-11-12" }, accounts: null, entities: null },
};

const GUARDED = Symbol.for("nearesis.guardedInference");
/** Mock inference: decides like a model would given the prompt, and records what it was shown. */
function mockProvider(plan: (prompt: string) => unknown) {
  const seen: string[] = [];
  const p = {
    id: "mock",
    health: async () => ({ ok: true, detail: "mock" }),
    listModels: async () => [],
    generateStructured: async <T>(a: {
      prompt: string;
      schema: z.ZodType<T>;
    }): Promise<StructuredResult<T>> => {
      seen.push(a.prompt);
      return {
        output: a.schema.parse(plan(a.prompt)),
        provider: "mock",
        model: "mock-1",
        requestId: `mock-${seen.length}`,
        usage: { inputTokens: 0, outputTokens: 0 },
        evidence: null,
        rawResponseSha256: "0".repeat(64),
      } as StructuredResult<T>;
    },
    streamText: async function* () {},
    verifyResponse: async () => ({ verified: false, status: "unattested_dev" as const, checks: [] }),
    [GUARDED]: true,
  } as unknown as InferenceProvider;
  return { provider: p, seen };
}

const refundPlan = {
  rationale: "The catalogue has no refund or status metric; use the intents analytics.",
  panels: [],
  analyticsPanels: [
    {
      title: "Swaps by status per week",
      capability: "intents.analyze@1",
      input: JSON.stringify({ analysis: "status", from: "2026-08-01", to: "2026-11-12", grain: "week" }),
    },
    {
      title: "Refunds per week",
      capability: "intents.analyze@1",
      input: JSON.stringify({
        analysis: "trend",
        from: "2026-08-01",
        to: "2026-11-12",
        granularity: "week",
        emphasis: "refund_rate",
      }),
    },
  ],
};

function gateway() {
  const calls: Array<{ cap: string; start: number; end: number }> = [];
  let tick = 0;
  const invoke = async (cap: string, input: unknown) => {
    const start = ++tick;
    await new Promise((r) => setTimeout(r, 5));
    const end = ++tick;
    calls.push({ cap, start, end });
    if (cap === "semantic.discover@1") return CATALOGUE;
    if (cap === "canvas.preview@1")
      throw new Error("canvas.preview must not be called without catalogue panels");
    const r = await runAnalytics(deps, cap as "intents.analyze@1", input);
    if (!r.ok)
      return {
        ok: false,
        status: r.status,
        error: {
          traceId: "t",
          errorCode: "VALIDATION_FAILED",
          reasonCode: r.code,
          message: r.message,
          retryable: false,
        },
      };
    return { ok: true, ...r.outcome };
  };
  return { invoke, calls };
}

const compose = (
  plan: (prompt: string) => unknown,
  key: string,
  over: { prompt?: string; invoke?: (c: string, i: unknown) => Promise<unknown> } = {},
) => {
  const m = mockProvider(plan);
  const g = gateway();
  return {
    m,
    g,
    run: () =>
      composeCanvas({
        prompt: over.prompt ?? OWNER_QUESTION,
        provider: m.provider,
        model: "mock-1",
        invoke: over.invoke ?? g.invoke,
        expectedRevision: 0,
        idempotencyKey: `${key}:compose`,
      }),
  };
};

describe("composer: analytics tools when the certified catalogue lacks the metric", () => {
  it("the owner's refunds question yields ANALYTICS_RESULT panels instead of abstaining", async () => {
    const t = compose(
      (prompt) =>
        prompt.includes("refunds") && prompt.includes("<analytics_tools")
          ? refundPlan
          : { rationale: "none", panels: [], analyticsPanels: [] },
      "run-1",
    );
    const r = await t.run();
    expect(r.status).toBe("ok");
    expect(t.m.seen[0]).toContain("intents.analyze@1"); // the model was shown the tools and the analytics data windows
    expect(t.m.seen[0]).toContain('"intents":{"from":"2026-04-01"');
    const ops = r.patch!.operations;
    expect(ops).toHaveLength(2);
    const panels = ops.map((o) => PanelSpec.parse((o as { panel: unknown }).panel));
    for (const p of panels) {
      expect(p.queryRef.resultKind).toBe("analytics_result");
      expect(p.queryRef.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.analytics).toMatchObject({
        label: "ANALYTICS_RESULT",
        certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
        capability: "intents.analyze@1",
      });
      expect(p.note).toMatch(/not a certified semantic metric/);
      expect(p.provenanceRequired).toBe(true);
    }
    expect(panels[0]).toMatchObject({
      kind: "bar",
      title: "Swaps by status per week",
      encoding: { x: "week", series: "status", y: ["swaps"] },
    });
    expect(panels[1]).toMatchObject({
      kind: "timeSeries",
      encoding: { x: "period", y: ["refundRate"] },
      dataBinding: { units: expect.objectContaining({ refundRate: "ratio" }) },
    });
    // the kernel's pure apply accepts the patch: every panel is structurally and semantically valid
    const applied = applyCanvasPatch(
      {
        id: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        branchId: "33333333-3333-4333-8333-333333333333",
        documentRevision: 0,
        dataRevision: 0,
        viewport: { zoom: 1, x: 0, y: 0 },
        layoutMode: "grid",
        panels: [],
        markers: [],
        activeSelections: [],
        updatedAt: NOW.toISOString(),
      },
      r.patch,
      { now: NOW.toISOString() },
    );
    expect(applied.ok, JSON.stringify(applied).slice(0, 400)).toBe(true);
    expect(r.analytics?.map((a) => [a.outcome, a.analysis])).toEqual([
      ["OK", "status"],
      ["OK", "trend"],
    ]);
  });

  it("tool calls run concurrently, with one discovery per composition", async () => {
    const t = compose(() => refundPlan, "run-2");
    await t.run();
    const [a, b] = t.g.calls.filter((c) => c.cap === "intents.analyze@1");
    expect(a && b).toBeTruthy();
    expect(Math.max(a!.start, b!.start)).toBeLessThan(Math.min(a!.end, b!.end)); // both started before either finished
    expect(t.g.calls.filter((c) => c.cap === "semantic.discover@1")).toHaveLength(1);
  });

  it("CANNOT_COMPUTE passes through: no panel is invented, the typed missing fields are reported", async () => {
    const t = compose(
      () => ({
        rationale: "solver share",
        panels: [],
        analyticsPanels: [
          {
            title: "Solver share",
            capability: "intents.analyze@1",
            input: JSON.stringify({ analysis: "solver_metrics", days: 7 }),
          },
        ],
      }),
      "run-3",
      { prompt: "solver market share?" },
    );
    const r = await t.run();
    expect(r.status).toBe("cannot_compute");
    expect(r.patch).toBeNull();
    expect(r.analytics?.[0]).toMatchObject({ outcome: "CANNOT_COMPUTE", missing: ["solver_id"] });
    expect(r.issues[0]).toMatchObject({ code: "CANNOT_COMPUTE" });
  });

  it("a skipped ask (invalid input) does not sink the panels that were computed", async () => {
    const plan = {
      ...refundPlan,
      analyticsPanels: [
        ...refundPlan.analyticsPanels,
        { title: "Bad", capability: "accounts.analyze@1", input: JSON.stringify({ analysis: "status" }) },
        { title: "Not JSON", capability: "intents.analyze@1", input: "{analysis: status" },
        {
          title: "Too wide",
          capability: "intents.analyze@1",
          input: JSON.stringify({ analysis: "trend", from: "2020-01-01", to: "2026-11-12" }),
        },
      ],
    };
    const r = await compose(() => plan, "run-4").run();
    expect(r.status).toBe("ok");
    expect(r.patch!.operations).toHaveLength(2);
    expect(r.analytics?.map((a) => a.outcome)).toEqual(["OK", "OK", "REFUSED", "REFUSED", "REFUSED"]);
    expect(r.issues.map((i) => i.code)).toEqual([
      "ANALYTICS_UNAVAILABLE",
      "ANALYTICS_UNAVAILABLE",
      "ANALYTICS_UNAVAILABLE",
    ]);
  });

  it("abstains only when neither the catalogue nor the analytics tools can answer", async () => {
    const r = await compose(
      () => ({ rationale: "no data for that", panels: [], analyticsPanels: [] }),
      "run-5",
      { prompt: "weather?" },
    ).run();
    expect(r).toMatchObject({ status: "cannot_compute", patch: null });
  });

  it("a missing grant stays a visible failure, not a silent abstention", async () => {
    const g = gateway();
    const invoke = async (cap: string, input: unknown) => {
      if (cap === "intents.analyze@1") throw new Error("intents.analyze@1: TOOL_NOT_GRANTED");
      return g.invoke(cap, input);
    };
    await expect(compose(() => refundPlan, "run-6", { invoke }).run()).rejects.toThrow(/TOOL_NOT_GRANTED/);
  });

  it("panel ids are stable across a retried composition (same idempotency key)", async () => {
    const ids = async () =>
      (await compose(() => refundPlan, "run-7").run()).patch!.operations.map(
        (o) => (o as { panel: { panelId: string } }).panel.panelId,
      );
    expect(await ids()).toEqual(await ids());
  });
});

describe("composer prompt stays in step with the capability schemas", () => {
  it("lists every analysis of every capability", () => {
    for (const analyses of Object.values(ANALYSES_BY_CAPABILITY))
      for (const a of analyses) expect(ANALYTICS_TOOLS, a).toContain(a);
  });
  it("the plan schema defaults analyticsPanels so a catalogue-only plan stays valid", () => {
    expect(ComposerPlan.parse({ rationale: "r", panels: [] }).analyticsPanels).toEqual([]);
  });
});

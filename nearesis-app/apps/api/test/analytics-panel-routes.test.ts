import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { AnalyticsPanelData } from "@nearesis/contracts";
import { callHashOf, type AnalyticsDeps, type IntentsAnalytics } from "@nearesis/analytics";
import { analyticsPanelRoutes } from "../src/analytics-panel-routes.ts";

const prov = {
  source: "s",
  tables: ["nearesis_live.intents_swaps"],
  asOf: "2026-11-12",
  computedAt: "2026-11-13T00:00:00Z",
  metricVersion: "intents-1.0.0",
  method: "m",
};
const cov = {
  dataset: "intents_swaps",
  source: "x",
  scopeNote: "s",
  window: { from: "2026-11-01", to: "2026-11-14" },
  daysInWindow: 14,
  completeDays: 14,
  incompleteDays: [],
  missingDays: [],
  swapRows: 10,
  usdUnknownRows: 0,
  usdKnownShare: "1",
  eraSplit: {},
  privateSettlementNote: "n",
};
const deps = {
  intents: {
    trend: async () => ({
      status: "OK",
      metric: "intents.trend",
      definition: "d",
      window: { from: "2026-11-01", to: "2026-11-14" },
      chart: { kind: "line" },
      data: [
        {
          period: "2026-11-02",
          swaps: 5,
          success: 4,
          refunded: 1,
          refundRate: "0.2",
          volumeUsdKnown: "10",
          swapsWithUnknownUsd: 0,
          days: 7,
        },
      ],
      coverage: cov,
      provenance: prov,
      caveats: [],
    }),
    solverMetrics: async () => ({
      status: "CANNOT_COMPUTE",
      metric: "intents.solver_metrics",
      missing: ["solver_id"],
      explanation: "no solver",
      evidence: [],
      coverage: null,
      provenance: prov,
    }),
  } as unknown as IntentsAnalytics,
  entities: {
    registry: async () => ({ registryVersion: "none", entities: [], mappings: [], relations: [] }),
    activity: async () => ({ receivers: [], remainder: [] }),
    latestDate: async () => null,
  },
  accounts: null,
  now: () => new Date("2026-11-13T00:00:00Z"),
} as AnalyticsDeps;

const input = {
  analysis: "trend",
  from: "2026-11-01",
  to: "2026-11-14",
  granularity: "week",
  emphasis: "swaps",
};
const solver = { analysis: "solver_metrics", from: "2026-11-01", to: "2026-11-14" };
const store = new Map<string, unknown>();
for (const [cap, i] of [
  ["intents.analyze@1", input],
  ["intents.analyze@1", solver],
] as const)
  store.set(callHashOf(cap, i), { kind: "analytics_call", capability: cap, input: i });
store.set("c".repeat(64), { kind: "semantic_query_not_analytics" });
const pool = {
  query: async (_sql: string, p: string[]) => {
    const ast = store.get(p[0]!);
    return {
      rows: ast ? [{ query_hash: p[0], ast, semantic_version: "1.0.0", semantic_model_hash: p[0] }] : [],
    };
  },
};

const app = Fastify();
let authed = true;
beforeAll(async () => {
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(analyticsPanelRoutes, {
    authenticate: async () => {
      if (!authed) throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no session");
      return {} as never;
    },
    deps,
    pool: pool as never,
  });
  await app.ready();
});
afterAll(async () => app.close());

describe("GET /v1/analytics/panel/:hash", () => {
  it("re-executes the stored call and returns typed panel data labelled ANALYTICS", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/analytics/panel/${callHashOf("intents.analyze@1", input)}`,
    });
    expect(r.statusCode).toBe(200);
    const body = AnalyticsPanelData.parse(r.json());
    expect(body.provenance).toMatchObject({
      sourceLabel: "ANALYTICS",
      certification: "SOURCE_TABLE_ANALYTICS_NOT_CERTIFIED_METRIC",
      analysis: "trend",
    });
    expect(body.chart.columns.map((c) => c.name)).toContain("refundRate");
    expect(body.cannotCompute).toBeNull();
  });
  it("a call the source cannot answer is 200 with cannotCompute, never a chart of zeros", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/analytics/panel/${callHashOf("intents.analyze@1", solver)}`,
    });
    expect(r.statusCode).toBe(200);
    const body = AnalyticsPanelData.parse(r.json());
    expect(body.cannotCompute).toMatchObject({ missing: ["solver_id"] });
    expect(body.chart.rows).toEqual([]);
    expect(body.chart.freshness).toBe("unavailable");
  });
  it("an unknown or non-analytics hash is 404 QUERY_UNKNOWN and a malformed one never reaches the store", async () => {
    for (const h of ["d".repeat(64), "c".repeat(64), "not-a-hash"]) {
      const r = await app.inject({ method: "GET", url: `/v1/analytics/panel/${h}` });
      expect(r.statusCode, h).toBe(404);
      expect(r.json().reasonCode).toBe("QUERY_UNKNOWN");
    }
  });
  it("requires a session", async () => {
    authed = false;
    const r = await app.inject({ method: "GET", url: `/v1/analytics/panel/${"d".repeat(64)}` });
    authed = true;
    expect(r.statusCode).toBe(401);
  });
});

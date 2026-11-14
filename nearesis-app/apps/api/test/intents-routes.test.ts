import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import type { IntentsAnalytics } from "@nearesis/analytics";
import { intentsRoutes } from "../src/intents-routes.ts";

const calls: Array<{ fn: string; args: unknown[] }> = [];
const rec =
  (fn: string, ret: unknown = { status: "OK", metric: fn }) =>
  (...args: unknown[]) => {
    calls.push({ fn, args });
    return Promise.resolve(ret);
  };
const stub = {
  defaultWindow: async (days: number) => ({ from: `d-${days}`, to: "2026-11-11" }),
  summary: rec("summary"),
  coverage: rec("coverage"),
  statusDistribution: rec("status"),
  assetVolume: rec("assets"),
  chainFlows: rec("flows"),
  assetPairs: rec("pairs"),
  refundRates: rec("refund"),
  routeUsage: rec("routes"),
  referralUsage: rec("refs"),
  sizeBuckets: rec("size"),
  trend: rec("trend"),
  chainPairGrowth: rec("growth"),
  concentrationOf: rec("conc"),
  unusualFlows: rec("unusual"),
  settlementDuration: rec("settle", {
    status: "CANNOT_COMPUTE",
    metric: "intents.settlement_duration",
    missing: ["settlement_completed_at"],
  }),
  settlementDurationMeasured: rec("settle", {
    status: "CANNOT_COMPUTE",
    metric: "intents.settlement_duration",
    missing: ["settlement_completed_at"],
  }),
  solverMetrics: rec("solver", {
    status: "CANNOT_COMPUTE",
    metric: "intents.solver_metrics",
    missing: ["solver_id"],
  }),
  quoteIntelligence: rec("quotes"),
  fieldInventory: () => ({ status: "OK", metric: "intents.field_inventory", data: [] }),
} as unknown as IntentsAnalytics;

const app = Fastify();
beforeAll(async () => {
  app.decorateRequest("traceId", "t-1");
  app.setErrorHandler((err, _req, reply) => {
    const { status, body } = toErrorResponse(err, "t-1");
    void reply.status(status).send(body);
  });
  await app.register(intentsRoutes, {
    analytics: stub,
    authenticate: async (req) => {
      if (req.headers.authorization !== "Bearer ok")
        throw new KernelError("UNAUTHENTICATED", "NO_SESSION", "no");
      return {} as never;
    },
  });
});
afterAll(async () => app.close());
const get = (url: string, auth = true) =>
  app.inject({ method: "GET", url, headers: auth ? { authorization: "Bearer ok" } : {} });

describe("intents routes", () => {
  it("require a session on every route", async () => {
    for (const p of ["summary", "field-inventory", "solver-metrics", "quotes", "unusual-flows"])
      expect((await get(`/v1/intents/${p}`, false)).statusCode).toBe(401);
  });
  it("default the window to 30 days ending at the newest complete day", async () => {
    calls.length = 0;
    const r = await get("/v1/intents/summary");
    expect(r.statusCode).toBe(200);
    expect(calls[0]).toEqual({ fn: "summary", args: [{ from: "d-30", to: "2026-11-11" }, undefined] });
  });
  it("passes explicit windows, era and options through", async () => {
    calls.length = 0;
    await get("/v1/intents/summary?from=2026-10-01&to=2026-10-31&era=public");
    await get(
      "/v1/intents/concentration?from=2026-10-01&to=2026-10-31&dimension=chain_pair&measure=count&top=3",
    );
    await get("/v1/intents/refund-rates?from=2026-10-01&to=2026-10-31&by=asset_pair&minTerminal=7");
    expect(calls.map((c) => c.args)).toEqual([
      [{ from: "2026-10-01", to: "2026-10-31" }, "public"],
      [{ from: "2026-10-01", to: "2026-10-31" }, "chain_pair", "count", 3],
      [{ from: "2026-10-01", to: "2026-10-31" }, "asset_pair", 7, 25],
    ]);
  });
  it("rejects malformed parameters with a typed 4xx and never runs a query", async () => {
    calls.length = 0;
    for (const u of [
      "summary?from=yesterday&to=2026-10-31",
      "concentration?dimension=drop_table",
      "summary?era=secret",
      "assets?top=100000",
      "unusual-flows?asOf=x",
    ]) {
      const r = await get(`/v1/intents/${u}`);
      expect(r.statusCode).toBe(422);
    }
    expect(calls).toEqual([]);
  });
  it("CANNOT_COMPUTE is a typed 200 answer naming the missing field", async () => {
    const s = (await get("/v1/intents/solver-metrics")).json() as { status: string; missing: string[] };
    expect(s).toMatchObject({ status: "CANNOT_COMPUTE", missing: ["solver_id"] });
    const d = (await get("/v1/intents/settlement-duration")).json() as { status: string };
    expect(d.status).toBe("CANNOT_COMPUTE");
  });
  it("unusual flows default to the newest complete day", async () => {
    calls.length = 0;
    await get("/v1/intents/unusual-flows");
    expect(calls[0]).toEqual({ fn: "unusual", args: ["2026-11-11", { baselineDays: 28, recentDays: 7 }] });
  });
  it("serves the field inventory", async () => {
    expect((await get("/v1/intents/field-inventory")).json()).toMatchObject({
      metric: "intents.field_inventory",
    });
  });
});

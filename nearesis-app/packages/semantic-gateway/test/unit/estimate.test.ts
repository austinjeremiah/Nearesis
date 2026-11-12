import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, createCh, loadLiveRegistry } from "@nearesis/analytics";
import { createGateway } from "../../src/gateway.ts";
import { DEFAULT_POLICY } from "../../src/types.ts";

// Disposable ClickHouse database and a stub Cube: `estimate` must cost a query without executing it.
const tag = `est_${Date.now().toString(36)}`;
const db = `nearesis_t_${tag}`;
const auth = {
  url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
};
const admin = createCh({ ...auth, database: "default" });
const ch = createCh({ ...auth, database: db });
const days = ["2026-05-01", "2026-05-02", "2026-05-03"];
const CNT = "intents_swaps_live.swap_count";
const DAYK = "intents_swaps_live.day.day";

let cube: Server;
let cubeUrl = "";
let loads = 0;
beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE ${db}` });
  await migrate(ch);
  cube = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/cubejs-api/v1/sql"))
      return void res.end(JSON.stringify({ sql: { preAggregations: [] } }));
    loads++;
    res.end(
      JSON.stringify({ data: days.map((d) => ({ [DAYK]: `${d}T00:00:00.000`, [CNT]: 3 })), annotation: {} }),
    );
  });
  await new Promise<void>((r) => cube.listen(0, "127.0.0.1", r));
  cubeUrl = `http://127.0.0.1:${(cube.address() as AddressInfo).port}`;
  await ch.insert({
    table: "intents_swaps",
    values: days.flatMap((d) =>
      Array.from({ length: 4 }, (_, i) => ({
        swap_key: `${d}-${i}`,
        created_at: `${d} 10:00:00`,
        created_day: d,
        fetched_at: `${d} 10:00:00`,
        version: 1,
      })),
    ),
    format: "JSONEachRow",
    clickhouse_settings: {
      input_format_defaults_for_omitted_fields: 1,
      date_time_input_format: "best_effort",
    },
  });
  await admin.insert({
    table: `${db}.source_coverage`,
    values: days.map((d) => ({
      provider_id: "near-explorer",
      dataset: "intents_swaps",
      day: d,
      state: "complete",
      reason: null,
      source_label: "LIVE",
      version: 1,
    })),
    format: "JSONEachRow",
  });
});
afterAll(async () => {
  await new Promise((r) => cube.close(r));
  await ch.close();
  await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
  await admin.close();
});

const reg = loadLiveRegistry();
const store = new Map<string, string>();
const gw = (maxEstimatedRows = 100000) =>
  createGateway({
    cubeUrl,
    cubeSecret: "s",
    redis: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
    },
    registry: reg,
    policyResolver: () => ({ ...DEFAULT_POLICY, maxEstimatedRows }),
    clock: () => new Date(),
    ch,
    readCacheMs: 0,
    warmRollups: false,
  });
const S = { tenantId: "t", workspaceId: "w", principalId: "p", aclClasses: ["member"] };
const q = (measures: string[], to = "2026-05-04T00:00:00Z") => ({
  semanticVersion: reg.semanticVersion,
  measures,
  dimensions: [],
  time: { field: "intents_swaps_live.day", from: "2026-05-01T00:00:00Z", to, grain: "day" },
  filters: [],
  order: [],
  limit: 100,
});

describe("gateway estimate", () => {
  it("costs a query from the same row rates as query() without loading from Cube or writing the cache", async () => {
    const g = gw();
    const e = await g.estimate(S, q(["live.oneclick_swap_count"]));
    expect(e.ok, JSON.stringify(e.ok ? "" : e.error)).toBe(true);
    if (!e.ok) return;
    expect(e).toMatchObject({
      withinCap: true,
      cached: false,
      rollupServed: false,
      maxEstimatedRows: 100000,
    });
    expect(e.estimatedRows).toBeGreaterThan(0);
    expect(e.bytesEstimated).toBe(e.estimatedRows * 200);
    expect(loads, "no Cube load").toBe(0);
    expect(store.size, "no cache write").toBe(0);
    expect(g.stats().executions).toBe(0);
    expect(g.audit()).toEqual([]);
  });

  it("agrees with the envelope the real query then returns, and reports a cache hit afterwards", async () => {
    const g = gw();
    const before = await g.estimate(S, q(["live.oneclick_swap_count"]));
    const r = await g.query(S, q(["live.oneclick_swap_count"]));
    expect(r.ok).toBe(true);
    if (!before.ok || !r.ok) return;
    expect(r.envelope.cost.bytesEstimated).toBe(before.bytesEstimated);
    expect(r.queryHash).toBe(before.queryHash);
    const after = await g.estimate(S, q(["live.oneclick_swap_count"]));
    expect(after.ok && after.cached).toBe(true);
    // another tenant does not share the cache
    const other = await g.estimate({ ...S, tenantId: "t2" }, q(["live.oneclick_swap_count"]));
    expect(other.ok && other.cached).toBe(false);
  });

  it("flags a query over the cost cap and refuses an invalid one with the gateway's own error", async () => {
    const over = await gw(1).estimate(S, q(["live.oneclick_swap_count"]));
    expect(over.ok && over.withinCap).toBe(false);
    const bad = await gw().estimate(S, { ...q(["live.nope"]) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(422);
  });
});

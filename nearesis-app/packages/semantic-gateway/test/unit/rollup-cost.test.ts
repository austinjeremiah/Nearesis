import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, createCh, loadLiveRegistry } from "@nearesis/analytics";
import { createGateway, estimateRows } from "../../src/gateway.ts";
import { DEFAULT_POLICY } from "../../src/types.ts";
import { applyRollupRates, rollupRates } from "../../src/rollup.ts";
import { rowRates } from "../../src/coverage.ts";

// Disposable ClickHouse databases: one for the fact tables, one standing in for Cube's pre-aggregation schema.
const tag = `a14_${Date.now().toString(36)}`;
const db = `nearesis_t_${tag}`;
const preDb = `nearesis_t_${tag}_pre`;
const url = process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123";
const auth = {
  url,
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
};
const admin = createCh({ ...auth, database: "default" });
const ch = createCh({ ...auth, database: db });
const SRC = "near-explorer:intents_swaps";
const ROLLUP_ID = "intents_swaps_live_facts.daily_swaps_rollup";
const BASE = "intents_swaps_live_facts_daily_swaps_rollup";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const swapRow = (key: string, day: string) => ({
  swap_key: key,
  created_at: `${day} 10:00:00`,
  created_day: day,
  fetched_at: `${day} 10:00:00`,
  version: 1,
});
const insertSwaps = (n: number, day: string, prefix: string) =>
  ch.insert({
    table: "intents_swaps",
    values: Array.from({ length: n }, (_, i) => swapRow(`${prefix}${i}`, day)),
    format: "JSONEachRow",
    clickhouse_settings: {
      input_format_defaults_for_omitted_fields: 1,
      date_time_input_format: "best_effort",
    },
  });
const buildRollup = async (suffix: string, rowsPerDay: number, days: string[]) => {
  await admin.command({
    query: `CREATE TABLE ${preDb}.${BASE}_aaaa1111_bbbb2222_${suffix}
            (intents_swaps_live_facts__day_day Date, intents_swaps_live_facts__status String, v UInt64)
            ENGINE = MergeTree ORDER BY tuple()`,
  });
  await admin.insert({
    table: `${preDb}.${BASE}_aaaa1111_bbbb2222_${suffix}`,
    values: days.flatMap((d) =>
      Array.from({ length: rowsPerDay }, (_, i) => ({
        intents_swaps_live_facts__day_day: d,
        intents_swaps_live_facts__status: `S${i}`,
        v: 1,
      })),
    ),
    format: "JSONEachRow",
  });
};

// Stand-in for Cube's GET /sql: reports the pre-aggregation Cube would route a swap_count-only query to.
let cube: Server;
let cubeUrl = "";
let cubeCovers = true;
const cubeRequests: string[] = [];
beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE ${db}` });
  await admin.command({ query: `CREATE DATABASE ${preDb}` });
  await migrate(ch);
  cube = createServer((req, res) => {
    cubeRequests.push(`${req.method} ${(req.url ?? "").split("?")[0]}`);
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/cubejs-api/v1/sql"))
      return void res.end(
        JSON.stringify({
          sql: {
            preAggregations: cubeCovers
              ? [{ preAggregationId: ROLLUP_ID, tableName: `${preDb}.${BASE}`, preAggregationsSchema: preDb }]
              : [],
          },
        }),
      );
    // /load (the warm-up, or an executed query): an empty result
    res.end(JSON.stringify({ data: [], annotation: {} }));
  });
  await new Promise<void>((r) => cube.listen(0, "127.0.0.1", r));
  cubeUrl = `http://127.0.0.1:${(cube.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => cube.close(r));
  await ch.close();
  await admin.command({ query: `DROP DATABASE IF EXISTS ${db}` });
  await admin.command({ query: `DROP DATABASE IF EXISTS ${preDb}` });
  await admin.close();
});

const cubeQuery = {
  measures: ["intents_swaps_live.swap_count"],
  dimensions: [],
  timeDimensions: [{ dimension: "intents_swaps_live.day", granularity: "day" }],
};

describe("rollup-aware cost estimate", () => {
  const days = ["2026-05-01", "2026-05-02", "2026-05-03"];

  it("no rollup built: covered query is UNBUILT and the raw estimate is used", async () => {
    await insertSwaps(300, days[0]!, "a");
    await insertSwaps(300, days[1]!, "b");
    await insertSwaps(300, days[2]!, "c");
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
    const r = await rollupRates(ch, cubeUrl, "tok", cubeQuery);
    expect(r).toEqual([
      { preAggregationId: ROLLUP_ID, table: "intents_swaps", state: "unbuilt", rowsPerDay: 0 },
    ]);
    const raw = (await rowRates(ch, [SRC])).perDay;
    expect(raw[SRC]).toBe(300);
    const a = applyRollupRates(raw, r);
    expect(estimateRows(a.perDay, 365)).toBe(300 * 365);
    expect(a.notReady).toHaveLength(1);
  });

  it("fresh rollup: estimate comes from the rollup's rows per day, far below raw", async () => {
    await sleep(2200); // timestamps have 1 s resolution: the rollup must be strictly newer than the last source part
    await buildRollup("v1", 4, days);
    const r = await rollupRates(ch, cubeUrl, "tok", cubeQuery);
    expect(r).toEqual([
      { preAggregationId: ROLLUP_ID, table: "intents_swaps", state: "fresh", rowsPerDay: 4 },
    ]);
    const raw = (await rowRates(ch, [SRC])).perDay;
    const a = applyRollupRates(raw, r);
    expect(a.served).toEqual([ROLLUP_ID]);
    expect(a.perDay[SRC]).toBe(4);
    expect(estimateRows(a.perDay, 365)).toBe(4 * 365);
    expect(estimateRows(a.perDay, 365)).toBeLessThan(estimateRows(raw, 365) / 50);
  });

  it("query not covered by any rollup: Cube reports none and the raw estimate stands", async () => {
    cubeCovers = false;
    try {
      expect(await rollupRates(ch, cubeUrl, "tok", cubeQuery)).toEqual([]);
      const raw = (await rowRates(ch, [SRC])).perDay;
      expect(applyRollupRates(raw, []).perDay).toEqual(raw);
    } finally {
      cubeCovers = true;
    }
  });

  it("stale rollup (source changed after it was built): falls back to raw, never the smaller rollup number", async () => {
    await sleep(2200);
    await insertSwaps(10, days[2]!, "late");
    const r = await rollupRates(ch, cubeUrl, "tok", cubeQuery);
    expect(r[0]?.state).toBe("stale");
    const raw = (await rowRates(ch, [SRC])).perDay;
    const a = applyRollupRates(raw, r);
    expect(a.perDay[SRC]).toBe(raw[SRC]);
    expect(a.perDay[SRC]).toBeGreaterThan(4);
    expect(a.served).toEqual([]);
  });

  it("a stale rollup is not mixed with a fresh one of the same table", () => {
    const out = applyRollupRates({ [SRC]: 300 }, [
      { preAggregationId: "x.fresh", table: "intents_swaps", state: "fresh", rowsPerDay: 2 },
      { preAggregationId: "x.stale", table: "intents_swaps", state: "stale", rowsPerDay: 0 },
    ]);
    expect(out.perDay[SRC]).toBe(300);
  });

  describe("through the gateway (cap 1000 rows, 30-day window)", () => {
    const reg = loadLiveRegistry();
    const store = new Map<string, string>();
    const gw = (o: object) =>
      createGateway({
        cubeUrl,
        cubeSecret: "s",
        redis: {
          get: async (k) => store.get(k) ?? null,
          set: async (k, v) => void store.set(k, v),
        },
        registry: reg,
        policyResolver: () => ({ ...DEFAULT_POLICY, maxEstimatedRows: 1000 }),
        clock: () => new Date(),
        ch,
        readCacheMs: 0,
        warmRollups: false,
        ...o,
      });
    const S = { tenantId: "t", workspaceId: "w", principalId: "p", aclClasses: ["member"] };
    const q = {
      semanticVersion: reg.semanticVersion,
      measures: ["live.oneclick_swap_count"],
      dimensions: [],
      time: {
        field: "intents_swaps_live.day",
        from: "2026-05-01T00:00:00Z",
        to: "2026-05-31T00:00:00Z",
        grain: "day",
      },
      filters: [],
      order: [],
      limit: 1000,
    };

    it("stale rollup: refused on the raw estimate (COST_CAP), and the retry hint says the rollup is refreshing", async () => {
      const r = await gw({}).query(S, q);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.reasonCode).toBe("COST_CAP");
        expect(r.error.message).toMatch(/Estimated 9\d{3} rows/);
        expect(r.error.nextAction).toMatch(/not built or is stale/);
      }
    });

    it("stale rollup with warm-up on: starts exactly one background load, then no more within a minute", async () => {
      const g = gw({ warmRollups: true });
      cubeRequests.length = 0;
      await g.query(S, q);
      await g.query(S, q);
      await sleep(150);
      expect(cubeRequests.filter((x) => x === "POST /cubejs-api/v1/load")).toHaveLength(1);
    });

    it("fresh rollup: the same query passes the cost gate (estimate from rollup rows) and executes", async () => {
      await sleep(2200);
      await buildRollup("v2", 4, days);
      const g = gw({});
      const r = await g.query(S, q);
      expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
      expect(g.stats().rollupEstimates).toBe(1);
    });

    it("rollup-aware cost disabled: the same query is refused again", async () => {
      const r = await gw({ rollupAwareCost: false }).query(S, q);
      expect(r.ok).toBe(false);
    });

    it("COVERAGE_UNKNOWN still wins over a fresh rollup", async () => {
      await ch.command({ query: "TRUNCATE TABLE source_coverage" });
      const r = await gw({}).query(S, q);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reasonCode).toBe("COVERAGE_UNKNOWN");
    });
  });
});

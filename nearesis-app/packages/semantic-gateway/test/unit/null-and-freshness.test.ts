import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataFrameEnvelope } from "@nearesis/contracts";
import { migrate, createCh, loadLiveRegistry } from "@nearesis/analytics";
import { createGateway } from "../../src/gateway.ts";
import { DEFAULT_POLICY } from "../../src/types.ts";

// Disposable ClickHouse databases: fact tables + a stand-in for Cube's pre-aggregation schema; a stub Cube.
const tag = `a26_${Date.now().toString(36)}`;
const db = `nearesis_t_${tag}`;
const preDb = `nearesis_t_${tag}_pre`;
const auth = {
  url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
};
const admin = createCh({ ...auth, database: "default" });
const ch = createCh({ ...auth, database: db });
const ROLLUP_ID = "intents_swaps_live_facts.daily_swaps_rollup";
const BASE = "intents_swaps_live_facts_daily_swaps_rollup";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const days = ["2026-05-01", "2026-05-02", "2026-05-03"];
const VOL = "intents_swaps_live.volume_usd_known";
const CNT = "intents_swaps_live.swap_count";
const DAYK = "intents_swaps_live.day.day";

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
const buildRollup = async (suffix: string) => {
  const t = `${preDb}.${BASE}_aaaa1111_bbbb2222_${suffix}`;
  await admin.command({
    query: `CREATE TABLE ${t} (intents_swaps_live_facts__day_day Date, v UInt64) ENGINE = MergeTree ORDER BY tuple()`,
  });
  await admin.insert({
    table: t,
    values: days.map((d) => ({ intents_swaps_live_facts__day_day: d, v: 1 })),
    format: "JSONEachRow",
  });
};

let cube: Server;
let cubeUrl = "";
let cubeData: Array<Record<string, string | number | null>> = [];
beforeAll(async () => {
  await admin.command({ query: `CREATE DATABASE ${db}` });
  await admin.command({ query: `CREATE DATABASE ${preDb}` });
  await migrate(ch);
  cube = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/cubejs-api/v1/sql"))
      return void res.end(
        JSON.stringify({
          sql: {
            preAggregations: [
              { preAggregationId: ROLLUP_ID, tableName: `${preDb}.${BASE}`, preAggregationsSchema: preDb },
            ],
          },
        }),
      );
    res.end(JSON.stringify({ data: cubeData, annotation: {} }));
  });
  await new Promise<void>((r) => cube.listen(0, "127.0.0.1", r));
  cubeUrl = `http://127.0.0.1:${(cube.address() as AddressInfo).port}`;
  for (const d of days) await insertSwaps(3, d, d);
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
  await admin.command({ query: `DROP DATABASE IF EXISTS ${preDb}` });
  await admin.close();
});

const reg = loadLiveRegistry();
const store = new Map<string, string>();
const ttls = new Map<string, number>();
const gw = () =>
  createGateway({
    cubeUrl,
    cubeSecret: "s",
    redis: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v, _ex, ttl) => {
        store.set(k, v);
        ttls.set(k, Number(ttl));
      },
    },
    registry: reg,
    policyResolver: () => ({ ...DEFAULT_POLICY, maxEstimatedRows: 100000 }),
    clock: () => new Date(),
    ch,
    readCacheMs: 0,
    warmRollups: false,
  });
const S = { tenantId: "t", workspaceId: "w", principalId: "p", aclClasses: ["member"] };
const q = (measures: string[]) => ({
  semanticVersion: reg.semanticVersion,
  measures,
  dimensions: [],
  time: {
    field: "intents_swaps_live.day",
    from: "2026-05-01T00:00:00Z",
    to: "2026-05-04T00:00:00Z",
    grain: "day",
  },
  filters: [],
  order: [],
  limit: 100,
});
const day = (d: string, o: Record<string, string | number | null>) => ({ [DAYK]: `${d}T00:00:00.000`, ...o });

describe("F1 null sums are never zero-filled", () => {
  it("a present NULL sum on a complete day stays NULL; only a missing bucket is zero-filled", async () => {
    await sleep(2200);
    await buildRollup("v1");
    // 05-01 has a known volume, 05-02 has swaps but ALL unknown USD (NULL sum), 05-03 has no bucket at all
    cubeData = [day("2026-05-01", { [VOL]: "12.5", [CNT]: 3 }), day("2026-05-02", { [VOL]: null, [CNT]: 3 })];
    const r = await gw().query(S, q(["live.oneclick_volume_usd_known"]));
    expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
    if (!r.ok) return;
    const byDay = Object.fromEntries(r.envelope.rows.map((x) => [String(x[0]).slice(0, 10), x[1]]));
    expect(byDay["2026-05-01"]).toBe("12.500000000000000000");
    expect(byDay["2026-05-02"], "all-unknown-USD day").toBeNull();
    expect(byDay["2026-05-03"], "no bucket record on a complete day").toBe("0.000000000000000000");
    expect(r.envelope.nullCount).toBe(1);
    expect(r.envelope.certification).toBe("partial");
  });
});

describe("F5 a lagging rollup is never labelled certified or cached", () => {
  it("fresh rollup: certified, vintage reported, cached", async () => {
    store.clear();
    ttls.clear();
    cubeData = days.map((d) => day(d, { [CNT]: 3 }));
    const r = await gw().query(S, q(["live.oneclick_swap_count"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    DataFrameEnvelope.parse(r.envelope);
    expect(r.envelope.certification).toBe("certified");
    expect(r.envelope.rollupFreshness).toMatchObject({ state: "fresh", lagSeconds: 0 });
    expect(r.envelope.rollupFreshness!.rollupBuiltAt).toBeTruthy();
    expect(store.size).toBe(1);
  });

  it("new rows land after the rollup was built: stale, with the lag, and not cached; then certified again once rebuilt", async () => {
    store.clear();
    ttls.clear();
    await sleep(2200);
    await insertSwaps(5, days[2]!, "late"); // source changes, the rollup does not
    cubeData = days.map((d) => day(d, { [CNT]: 3 })); // Cube still answers from the old rollup
    const g = gw();
    const stale = await g.query(S, q(["live.oneclick_swap_count"]));
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.envelope.certification).toBe("stale");
    expect(stale.envelope.rollupFreshness?.state).toBe("stale");
    expect(stale.envelope.rollupFreshness!.lagSeconds).toBeGreaterThan(0);
    expect(Date.parse(stale.envelope.rollupFreshness!.sourceChangedAt!)).toBeGreaterThan(
      Date.parse(stale.envelope.rollupFreshness!.rollupBuiltAt!),
    );
    expect([...ttls.values()], "a stale envelope is cached for seconds only").toEqual([2]);

    await sleep(2200);
    await buildRollup("v2"); // the rollup catches up
    store.clear(); // the 2 s cache entry has expired (the fake redis ignores TTLs)
    const ok = await g.query(S, q(["live.oneclick_swap_count"]));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.envelope.certification).toBe("certified");
      expect(ok.envelope.rollupFreshness?.state).toBe("fresh");
    }
  });
});

describe("F4 the envelope carries what the panel needs: coverage, gaps incl. partial days, cost, generatedAt, sources", () => {
  it("a STILL_FILLING day is listed in gaps with its reason; per-row coverage, cost, generatedAt and sources are present", async () => {
    await admin.insert({
      table: `${db}.source_coverage`,
      values: [
        {
          provider_id: "near-explorer",
          dataset: "intents_swaps",
          day: days[2],
          state: "partial",
          reason: "STILL_FILLING",
          source_label: "LIVE",
          version: 2,
        },
      ],
      format: "JSONEachRow",
    });
    store.clear();
    ttls.clear();
    cubeData = days.map((d) => day(d, { [CNT]: 3 }));
    const r = await gw().query(S, q(["live.oneclick_swap_count"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.envelope;
    DataFrameEnvelope.parse(e);
    expect(e.rowCoverage).toEqual(["complete", "complete", "partial"]);
    expect(e.gaps).toContainEqual({
      from: "2026-05-03T00:00:00.000Z",
      to: "2026-05-04T00:00:00.000Z",
      reason: "STILL_FILLING",
    });
    expect(e.cost.bytesEstimated).toBeGreaterThanOrEqual(0);
    expect(Date.parse(e.generatedAt)).not.toBeNaN();
    expect(e.sources).toEqual(["near-explorer"]);
    expect(e.certification).toBe("partial");
  });
});

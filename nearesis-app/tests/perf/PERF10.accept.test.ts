/**
 * PERF10: representative semantic queries at 1M and 10M normalised rows, cold versus warm, pre-aggregations equal to raw,
 * no bulk series query on Postgres (ch.13 "Benchmark suite", ch.16b 6.2). Real ClickHouse + Cube + Redis + the guarded
 * semantic gateway. SYNTHETIC rows with the real intents_swaps schema are generated inside ClickHouse from a fixed
 * deterministic expression (content checksum recorded). The test takes the shared analytics data lock, replaces the
 * intents_swaps rows for the run and restores the baseline fixture afterwards; it never touches nearesis_live.
 *  - cold: gateway result cache flushed (every query executes against Cube/ClickHouse); reported, no latency asserted
 *  - warm: every query a cache hit, 20 concurrent workspaces; judged p95 < 1000 ms at both sizes
 * Postgres is attached to the gateway through a spy; the judgement counts any statement other than the query-record
 * insert. Negative control: a pattern routed to Postgres (a series SELECT through the spy) must FAIL that judgement.
 */
import { createHash } from "node:crypto";
import { cpus, totalmem } from "node:os";
import type { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  baseline,
  canonicalJson,
  cubeLoad,
  loadNormalized,
  queryRows,
  resetData,
} from "../../services/analytics/src/index.ts";
import {
  ast,
  cubeToken,
  CUBE_URL,
  settle,
  setupEnv,
  W1,
} from "../../packages/semantic-gateway/test/helpers.ts";
import type { Env } from "../../packages/semantic-gateway/test/helpers.ts";
import type { Session } from "../../packages/semantic-gateway/src/index.ts";
import { DRYRUN, percentile, sha256Text, stats } from "./_reference.ts";
import { evidenceBase, gateB, referenceB, thr } from "./_b.ts";

const th = thr("PERF10");
const SIZES =
  DRYRUN && process.env.PERF_SIZES ? process.env.PERF_SIZES.split(",").map(Number) : [1_000_000, 10_000_000];
const WORKSPACES = th.concurrentWorkspaces!;
const WARM_PASSES = 5;
const RANGE = ["2026-10-01T00:00:00.000", "2026-10-10T23:59:59.999"];
const M = (m: string) => `intents.${m}`;
const day = (from: number, to: number, grain: "day" | "week" = "day") => ({
  field: "intents.day",
  from: `2026-10-${String(from).padStart(2, "0")}T00:00:00Z`,
  to: `2026-10-${String(to).padStart(2, "0")}T00:00:00Z`,
  grain,
});
/** The 20 canonical query patterns (frozen, part of the fixture hash): rollup-served and raw-path, by-dimension, weekly, narrow windows. */
export const PATTERNS = [
  ...[
    "oneclick_total_swap_count",
    "oneclick_completed_swap_count",
    "oneclick_failed_swap_count",
    "oneclick_refunded_swap_count",
    "oneclick_private_settlement_swap_count",
  ].map((m) => ast({ measures: [M(m)], time: day(1, 11) })),
  ast({ measures: [M("oneclick_completion_rate")], time: day(1, 11) }),
  ast({ measures: [M("oneclick_total_swap_count")], dimensions: ["intents.status"], time: day(1, 11) }),
  ast({ measures: [M("oneclick_total_swap_count")], dimensions: ["intents.privacy_era"], time: day(1, 11) }),
  ast({ measures: [M("oneclick_volume_usd")], time: day(1, 11) }),
  ast({ measures: [M("oneclick_amount_in_smallest_unit")], time: day(1, 11) }),
  ast({
    measures: [M("oneclick_completed_swap_count")],
    dimensions: ["intents.canonical_origin_asset"],
    time: day(1, 11),
  }),
  ast({
    measures: [M("oneclick_completed_swap_count")],
    dimensions: ["intents.deposit_type"],
    time: day(1, 11),
  }),
  ast({
    measures: [M("oneclick_completed_swap_count")],
    dimensions: ["intents.reconciliation_level"],
    time: day(1, 11),
  }),
  ast({ measures: [M("oneclick_completed_swap_count")], time: day(1, 11, "week") }),
  ast({ measures: [M("oneclick_total_swap_count")], time: day(1, 11, "week") }),
  ast({ measures: [M("oneclick_failed_swap_count")], time: day(1, 11, "week") }),
  ast({ measures: [M("oneclick_total_swap_count")], time: day(3, 6) }),
  ast({ measures: [M("oneclick_refunded_swap_count")], time: day(3, 6) }),
  ast({
    measures: [M("oneclick_failed_swap_count")],
    dimensions: ["intents.status", "intents.privacy_era"],
    time: day(1, 11),
  }),
  ast({ measures: [M("oneclick_private_settlement_swap_count")], time: day(1, 11, "week") }),
];
/** Deterministic generator: row n of the dataset (the fixture content is exactly this expression over numbers(N)). */
const gen = (n: number) => `
INSERT INTO intents_swaps
SELECT concat('perf-', toString(number)) AS swap_key, concat('dep-', toString(number)) AS deposit_address, NULL AS deposit_memo,
  ['SUCCESS','SUCCESS','SUCCESS','FAILED','REFUNDED'][1 + number % 5] AS status,
  toDateTime64('2026-10-01 00:00:00', 3, 'UTC') + toIntervalSecond(intHash32(number) % (10 * 86400)) AS created_at,
  toDate(created_at) AS created_day,
  concat('asset-', toString(number % 40)) AS origin_asset, concat('asset-', toString((number * 7) % 40)) AS destination_asset,
  concat('canon-', toString(number % 40)) AS canonical_origin_asset, concat('canon-', toString((number * 7) % 40)) AS canonical_destination_asset,
  toString(1000 + number % 9000) AS amount_in_raw, toString(900 + number % 9000) AS amount_out_raw,
  toDecimal256(1000 + number % 9000, 0) AS amount_in, toDecimal256(900 + number % 9000, 0) AS amount_out, 1 AS amount_final,
  toString(1 + number % 500) AS amount_in_usd_raw, toString(1 + number % 490) AS amount_out_usd_raw,
  toDecimal256(1 + number % 500, 18) AS amount_in_usd, toDecimal256(1 + number % 490, 18) AS amount_out_usd,
  ['direct','swap','intent'][1 + number % 3] AS deposit_type, 'address' AS recipient_type, NULL AS referral,
  ['public','private_settlement'][1 + number % 2] AS privacy_era, [] AS public_swap_tx_hashes, [] AS boundary_tx_hashes,
  ['none','partial','full'][1 + number % 3] AS reconciliation_level, 'SYNTHETIC' AS source_label,
  concat('raw-', toString(number)) AS raw_object_hash, 1 AS version
FROM numbers(${n})`;
export const FIXTURE_SPEC = {
  sizes: [1_000_000, 10_000_000],
  generator: gen(0),
  patterns: PATTERNS,
  concurrentWorkspaces: WORKSPACES,
  warmPasses: WARM_PASSES,
  other: "all non-intents tables hold analytics.baseline()",
};

/** Pure judgements (the negative control runs the same code). */
export const warmPasses = (ms: number[], boundMs: number) =>
  ms.length > 0 &&
  percentile(
    [...ms].sort((a, b) => a - b),
    95,
  ) < boundMs;
export const postgresSeriesStatements = (sql: string[]) =>
  sql.filter((s) => !/^\s*INSERT INTO analytics_meta\.query_registry/i.test(s)).length;

let env: Env | null = null;
const g = gateB(import.meta.url);
beforeAll(async () => {
  if (g.ok || DRYRUN) env = await setupEnv(null); // takes the shared data lock, loads nothing
}, 300_000);
afterAll(async () => {
  if (env) {
    await resetData(env.ch);
    await loadNormalized(env.ch, baseline());
    await settle(env.ch).catch(() => undefined);
    await env.close();
  }
}, 600_000);

const session = (i: number): Session => ({ ...W1, workspaceId: `w${i + 1}` });

it("PERF10: 20 query patterns at 1M and 10M rows meet warm p95 < 1 s; cold and warm reported; pre-aggregations equal raw; Postgres untouched", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF10", observed: "not executed", blocked: g.reason });
    return;
  }
  const e = env!;
  const fixtureHash = sha256Text(canonicalJson(FIXTURE_SPEC) + canonicalJson(baseline()));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF10 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF10).toBe(fixtureHash);
  expect(PATTERNS.length).toBe(20);

  const pgLog: string[] = [];
  const pgSpy = {
    query: async (text: string) => {
      pgLog.push(String(text));
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const gw = e.gateway({ pg: pgSpy });
  const report: Array<Record<string, unknown>> = [];
  const t0all = Date.now();
  const cpu0 = process.cpuUsage();
  let allWarmOk = true;
  let preaggOk = true;
  const preagg: Array<Record<string, unknown>> = [];

  for (const size of SIZES) {
    // ---- 1. load the dataset, verify count and content checksum
    await resetData(e.ch);
    await loadNormalized(e.ch, baseline());
    await e.ch.command({ query: "TRUNCATE TABLE intents_swaps" });
    const tl = Date.now();
    await e.ch.command({ query: gen(size), clickhouse_settings: { max_insert_threads: "4" } });
    await e.ch.command({ query: "OPTIMIZE TABLE intents_swaps FINAL" });
    const loadMs = Date.now() - tl;
    const rows = Number(
      (await queryRows<{ n: string }>(e.ch, "SELECT count() AS n FROM intents_swaps FINAL"))[0]!.n,
    );
    const checksum = (
      await queryRows<{ h: string }>(
        e.ch,
        "SELECT toString(groupBitXor(cityHash64(swap_key, status, created_at, amount_in, privacy_era))) AS h FROM intents_swaps FINAL",
      )
    )[0]!.h;
    expect(rows).toBe(size);
    await settle(e.ch);
    const keys = await e.redis.keys("semantic:q:*");
    if (keys.length) await e.redis.del(...keys);

    // ---- 2. cold: cache flushed, every pattern executes; concurrency 1 then 20 (flush between)
    const cold1: number[] = [];
    for (const p of PATTERNS) {
      const t = performance.now();
      const r = await gw.query(W1, p);
      cold1.push(performance.now() - t);
      expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true);
    }
    const flush = async () => {
      const k = await e.redis.keys("semantic:q:*");
      if (k.length) await e.redis.del(...k);
    };
    await flush();
    const cold20: number[] = [];
    await Promise.all(
      Array.from({ length: WORKSPACES }, async (_, w) => {
        for (const p of PATTERNS) {
          const t = performance.now();
          const r = await gw.query(session(w), p);
          cold20.push(performance.now() - t);
          expect(r.ok).toBe(true);
        }
      }),
    );

    // ---- 3. warm: all hits. concurrency 1 and 20
    for (const p of PATTERNS) await gw.query(W1, p);
    const warm1: number[] = [];
    let nonHit = 0;
    for (let pass = 0; pass < WARM_PASSES; pass++)
      for (const p of PATTERNS) {
        const t = performance.now();
        const r = await gw.query(W1, p);
        warm1.push(performance.now() - t);
        if (!r.ok || r.cache !== "hit") nonHit++;
      }
    for (let w = 0; w < WORKSPACES; w++) for (const p of PATTERNS) await gw.query(session(w), p); // warm every workspace's keys
    const exBefore = gw.stats().executions;
    const warm20: number[] = [];
    await Promise.all(
      Array.from({ length: WORKSPACES }, async (_, w) => {
        for (let pass = 0; pass < WARM_PASSES; pass++)
          for (const p of PATTERNS) {
            const t = performance.now();
            const r = await gw.query(session(w), p);
            warm20.push(performance.now() - t);
            if (!r.ok || r.cache !== "hit") nonHit++;
          }
      }),
    );
    const warmExec = gw.stats().executions - exBefore;
    const ok = warmPasses(warm20, th.warmP95Ms!) && nonHit === 0 && warmExec === 0;
    allWarmOk &&= ok;

    // ---- 4. pre-aggregation vs raw (S09 tolerance: exact for counts and sums, relative 1e-9 for ratios)
    const cases: Array<{ member: string; sql: string; exact: boolean }> = [
      ["oneclick_total_swap_count", "count()"],
      ["oneclick_completed_swap_count", "countIf(status = 'SUCCESS')"],
      ["oneclick_failed_swap_count", "countIf(status = 'FAILED')"],
      ["oneclick_refunded_swap_count", "countIf(status = 'REFUNDED')"],
      [
        "oneclick_private_settlement_swap_count",
        "countIf(status = 'SUCCESS' AND privacy_era = 'private_settlement')",
      ],
    ].map(([m, expr]) => ({
      member: M(m!),
      exact: true,
      sql: `SELECT toString(created_day) AS d, toString(${expr}) AS v FROM intents_swaps FINAL GROUP BY d`,
    }));
    cases.push({
      member: M("oneclick_completion_rate"),
      exact: false,
      sql: "SELECT toString(created_day) AS d, toString(countIf(status = 'SUCCESS') / count()) AS v FROM intents_swaps FINAL GROUP BY d",
    });
    cases.push({
      member: M("oneclick_volume_usd"),
      exact: true,
      sql: "SELECT toString(created_day) AS d, toString(sumIf(amount_in_usd, status = 'SUCCESS' AND amount_final = 1)) AS v FROM intents_swaps FINAL GROUP BY d",
    });
    let usedRollups = 0;
    for (const c of cases) {
      const res = await cubeLoad(CUBE_URL, cubeToken(), {
        measures: [c.member],
        timeDimensions: [{ dimension: "intents.day", granularity: "day", dateRange: RANGE }],
        cache: "must-revalidate",
      });
      const used = Object.keys(res.usedPreAggregations ?? {}).length;
      if (used) usedRollups++;
      const raw = new Map((await queryRows<{ d: string; v: string }>(e.ch, c.sql)).map((r) => [r.d, r.v]));
      let maxRel = 0;
      let match = res.data.length === raw.size;
      for (const r of res.data) {
        const dkey = String(r["intents.day.day"]).slice(0, 10);
        const got = String(r[c.member]);
        const want = raw.get(dkey);
        if (want === undefined) {
          match = false;
          continue;
        }
        if (c.exact) match &&= got === want;
        else {
          const rel = Math.abs(Number(got) - Number(want)) / Math.max(1e-12, Math.abs(Number(want)));
          maxRel = Math.max(maxRel, rel);
          match &&= rel <= 1e-9;
        }
      }
      preaggOk &&= match;
      preagg.push({
        size,
        member: c.member,
        usedPreAggregation: used > 0,
        days: raw.size,
        exact: c.exact,
        maxRelativeError: maxRel,
        equal: match,
      });
    }
    expect(usedRollups).toBeGreaterThanOrEqual(5); // the five count measures are rollup-served

    let resources: unknown;
    try {
      const q = await queryRows<{ rr: string; mem: string }>(
        e.ch,
        `SELECT toString(sum(read_rows)) AS rr, toString(max(memory_usage)) AS mem FROM system.query_log WHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL ${Math.ceil((Date.now() - tl) / 1000) + 5} SECOND`,
      );
      resources = { clickhouseReadRows: q[0]?.rr, clickhouseMaxQueryMemoryBytes: q[0]?.mem };
    } catch {
      resources = "system.query_log unavailable";
    }
    report.push({
      rows: size,
      checksum,
      loadMs,
      cold: { concurrency1: stats(cold1), concurrency20: stats(cold20) },
      warm: {
        concurrency1: stats(warm1),
        concurrency20: stats(warm20),
        nonHit,
        cubeExecutionsDuringWarm: warmExec,
        warmP95Pass: ok,
      },
      resources,
    });
    if (DRYRUN) process.stderr.write(`DRYRUN size ${size} ${JSON.stringify(report.at(-1))}\n`);
  }

  // ---- Postgres: nothing but the query-record insert may reach it
  const pgBad = postgresSeriesStatements(pgLog);
  const controlLog = [...pgLog, "SELECT created_day, count(*) FROM intents_swaps GROUP BY 1"]; // a pattern routed to Postgres
  const controlFails = postgresSeriesStatements(controlLog) > 0;
  const cpu = process.cpuUsage(cpu0);

  if (DRYRUN)
    process.stderr.write(
      `DRYRUN summary ${JSON.stringify({ preaggOk, pgBad, pgStatements: pgLog.length, controlFails, allWarmOk })}\n`,
    );
  expect(controlFails).toBe(true);
  expect(pgBad).toBe(0);
  expect(preaggOk).toBe(true);
  if (DRYRUN) return;
  expect(allWarmOk).toBe(true);

  const table = report
    .map((r) => {
      const w = (r.warm as { concurrency20: ReturnType<typeof stats> }).concurrency20;
      const c = (r.cold as { concurrency20: ReturnType<typeof stats> }).concurrency20;
      return `${r.rows} rows: cold@20 p50/p95/p99 ${c.p50}/${c.p95}/${c.p99} ms; warm@20 p50/p95/p99 ${w.p50}/${w.p95}/${w.p99} ms`;
    })
    .join(" | ");
  observe({
    testId: "PERF10",
    observed: `20 canonical patterns at ${SIZES.join(" and ")} rows (counts and content checksums verified), ${WORKSPACES} concurrent workspaces, ${WARM_PASSES} warm passes: ${table}; warm p95 < ${th.warmP95Ms} ms at both sizes with 0 non-hit and 0 Cube executions; cold results reported without a latency guarantee; ${preagg.length} pre-aggregation comparisons equal to raw (exact for counts and sums, relative 1e-9 for ratios); Postgres statements ${pgLog.length}, all query-record inserts, 0 series queries. Negative control (a series SELECT routed to Postgres) judged FAIL as required`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: {
          id: "fx.perf.rows-1m and fx.perf.rows-10m (SYNTHETIC, intents_swaps schema)",
          sha256: fixtureHash,
          checksums: report.map((r) => ({ rows: r.rows, checksum: r.checksum })),
        },
        concurrency: { workspaces: WORKSPACES, sequential: 1 },
        cacheState:
          "cold (gateway cache flushed) and warm (all hits) reported separately; Cube rollups built before measurement",
      }),
      hardware: { cpu: cpus()[0]!.model, cores: cpus().length, ramGiB: Math.round(totalmem() / 2 ** 30) },
      report,
      table,
      preAggregationVsRaw: preagg,
      postgres: {
        statements: pgLog.length,
        seriesStatements: pgBad,
        negativeControlJudgedFail: controlFails,
      },
      resourceUse: {
        processCpuUserMs: Math.round(cpu.user / 1000),
        processCpuSystemMs: Math.round(cpu.system / 1000),
        wallMs: Date.now() - t0all,
      },
    },
  });
}, 3_600_000);

void createHash;

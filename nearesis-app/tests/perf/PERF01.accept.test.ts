/**
 * PERF01: cached semantic query under parallel load. PASS: measured p95 under the SLO (ch.13: cached query p95 < 1 s)
 * with the environment recorded. Real ClickHouse + Cube + Redis + the guarded semantic gateway, the frozen baseline
 * fixture, 20 concurrent clients over 20 distinct query shapes. Cold (first execution) and warm (cache hit) results are
 * reported separately; only the warm distribution is judged against the SLO.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, canonicalJson, sha256 } from "../../services/analytics/src/index.ts";
import { ast, setupEnv, W1 } from "../../packages/semantic-gateway/test/helpers.ts";
import type { Env } from "../../packages/semantic-gateway/test/helpers.ts";
import { DRYRUN, conditions, gate, reference, stats } from "./_reference.ts";

const CONCURRENCY = 20;
const WARM_REQUESTS = 4000;
const M = "intents.oneclick_completed_swap_count";

/** The 20 query shapes: 10 windows x 2 limits. Frozen: part of the fixture hash. */
export const QUERY_SHAPES = Array.from({ length: 20 }, (_, i) =>
  ast({
    measures: [M],
    time: {
      field: "intents.day",
      from: `2026-10-0${1 + (i % 4)}T00:00:00Z`,
      to: `2026-10-${String(5 + (i % 6) + 1).padStart(2, "0")}T00:00:00Z`,
      grain: "day",
    },
    limit: i < 10 ? 1000 : 999,
  }),
);
export const FIXTURE_SPEC = {
  dataset: "analytics.baseline()",
  shapes: QUERY_SHAPES,
  concurrency: CONCURRENCY,
  warmRequests: WARM_REQUESTS,
};

let env: Env | null = null;
const g = gate(import.meta.url);
beforeAll(async () => {
  if (g.ok || DRYRUN) env = await setupEnv(baseline());
}, 300_000);
afterAll(async () => env?.close());

it("PERF01: warm cached semantic queries under 20-way parallel load meet p95 < 1 s", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF01", observed: "not executed", blocked: g.reason });
    return;
  }
  const ref = reference();
  const th = ref.thresholds.PERF01!;
  const gw = env!.gateway();
  const dataHash = sha256(canonicalJson(baseline()));
  const fixtureHash = createHash("sha256")
    .update(canonicalJson(FIXTURE_SPEC) + dataHash)
    .digest("hex");
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF01 ${fixtureHash}\n`);
  if (g.ok) expect(ref.fixtures.PERF01).toBe(fixtureHash);

  // ---- cold: first execution of each shape (Cube + ClickHouse), 5 at a time
  const cold: number[] = [];
  const coldQueue = [...QUERY_SHAPES];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      for (let q = coldQueue.shift(); q; q = coldQueue.shift()) {
        const t0 = performance.now();
        const r = await gw.query(W1, q);
        cold.push(performance.now() - t0);
        expect(r.ok).toBe(true);
        expect(r.ok && r.cache).toBe("miss");
      }
    }),
  );
  const execAfterCold = gw.stats().executions;
  expect(execAfterCold).toBeGreaterThanOrEqual(QUERY_SHAPES.length);

  // ---- warm: 20 concurrent clients, every request must be answered from the cache
  const warm: number[] = [];
  let errors = 0;
  const errorCodes: Record<string, number> = {};
  let nonHit = 0;
  let next = 0;
  const wallStart = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, c) => {
      for (;;) {
        const i = next++;
        if (i >= WARM_REQUESTS) return;
        const q = QUERY_SHAPES[(i + c) % QUERY_SHAPES.length]!;
        const t0 = performance.now();
        const r = await gw.query(W1, q);
        warm.push(performance.now() - t0);
        if (!r.ok) {
          errors++;
          errorCodes[r.status + ":" + JSON.stringify((r as { error?: unknown }).error).slice(0, 160)] =
            (errorCodes[r.status + ":" + JSON.stringify((r as { error?: unknown }).error).slice(0, 160)] ??
              0) + 1;
        } else if (r.cache !== "hit") nonHit++;
      }
    }),
  );
  const wallMs = performance.now() - wallStart;
  const s = gw.stats();
  const w = stats(warm);
  const c = stats(cold);

  expect(errorCodes).toEqual({});
  expect(errors).toBe(0);
  expect(nonHit).toBe(0);
  expect(s.executions).toBe(execAfterCold); // no Cube execution during the warm phase
  if (DRYRUN) return;
  expect(w.n).toBeGreaterThanOrEqual(th.minWarmSamples!);
  expect(w.p95).toBeLessThan(th.warmP95Ms!);

  const chRows = (await env!.ch
    .query({ query: "SELECT count() AS n FROM nearesis.intents_swaps", format: "JSONEachRow" })
    .then((r) => r.json())
    .catch(() => [])) as Array<{ n: string }>;
  observe({
    testId: "PERF01",
    observed: `warm cached semantic query, ${CONCURRENCY} concurrent clients, ${w.n} requests over ${QUERY_SHAPES.length} shapes in ${Math.round(wallMs)} ms (${Math.round((w.n / wallMs) * 1000)} req/s): p50 ${w.p50} ms, p95 ${w.p95} ms, p99 ${w.p99} ms, max ${w.max} ms, errors ${errors}, non-hit ${nonHit}, Cube executions during warm phase 0; SLO p95 < ${th.warmP95Ms} ms met. Cold first execution (n=${c.n}): p50 ${c.p50} ms, p95 ${c.p95} ms, p99 ${c.p99} ms (reported, not judged)`,
    fixtureHash,
    evidence: {
      environment: "reference",
      profile: g.ok ? g.fingerprint : null,
      referenceSha256: g.ok ? g.referenceSha256 : null,
      adrSha256: g.ok ? g.adrSha256 : null,
      conditions: conditions(),
      dataset: { id: "analytics.baseline()", sha256: dataHash, intentsSwapsRows: chRows[0]?.n ?? null },
      concurrency: CONCURRENCY,
      warm: { ...w, throughputPerSec: Math.round((w.n / wallMs) * 1000) },
      cold: c,
      gatewayStats: s,
      cacheState: "warm (judged) and cold (reported)",
    },
  });
}, 600_000);

import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetricMetadata } from "@nearesis/contracts";
import { observe } from "@nearesis/acceptance";
import {
  baseline,
  canonicalJson,
  cubeDryRun,
  cubeLoad,
  cubeMeta,
  generateMetricsMd,
  queryRows,
  SERVICE_ROOT,
} from "../../src/index.ts";
import { CUBE_URL, cubeToken, setupEnv, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const RANGE = ["2026-10-01T00:00:00.000", "2026-10-10T23:59:59.999"];
const PINNED = "cubejs/cube:v1.8.18@sha256:d382326a0d2786242c3992f3dd462efbea82d07b2823ecdc83d619d2d6f5dcb7";

test("S13 catalog completeness, compile and pre-aggregations on the pinned Cube", async () => {
  const reg = env.registry;
  // (a) every registry entry validates and every required ch.06 field is non-empty or an explicit n/a
  const fieldReport: Array<{ id: string; missing: string[] }> = [];
  for (const m of reg.metrics) {
    MetricMetadata.parse(m);
    const missing = Object.entries(m)
      .filter(([, v]) => v === null || v === "" || (Array.isArray(v) && v.length === 0))
      .map(([k]) => k);
    fieldReport.push({ id: m.id, missing });
  }
  const certified = reg.metrics.filter((m) => m.certified);
  expect(certified.length).toBeGreaterThanOrEqual(20);
  expect(fieldReport.filter((f) => f.missing.length)).toEqual([]);

  // pinned image
  const compose = readFileSync(
    join(SERVICE_ROOT, "..", "..", "infrastructure", "compose", "analytics.yml"),
    "utf8",
  );
  expect(compose).toContain(PINNED);
  const inspect = spawnSync("docker", ["inspect", "nearesis-cube-1", "--format", "{{.Config.Image}}"], {
    encoding: "utf8",
  });
  expect(inspect.stdout.trim()).toBe(PINNED);

  // (b)+(c) /meta compiles; views; member set and meta equal the registry
  const meta = await cubeMeta(CUBE_URL, cubeToken());
  const views = meta.cubes.filter((c) => c.type === "view");
  expect(views.length).toBeGreaterThanOrEqual(6);
  expect(meta.cubes.filter((c) => c.type !== "view")).toHaveLength(0); // base cubes are not public
  const measures = views.flatMap((v) => v.measures as Array<{ name: string; meta: unknown }>);
  expect(new Set(measures.map((m) => m.name))).toEqual(new Set(reg.metrics.map((m) => m.cubeMember)));
  for (const m of measures) {
    const r = reg.metrics.find((x) => x.cubeMember === m.name)!;
    expect(canonicalJson(m.meta), m.name).toBe(canonicalJson(r));
  }
  const dims = views.flatMap((v) => (v.dimensions as Array<{ name: string }>).map((d) => d.name));
  expect(new Set(dims)).toEqual(new Set(reg.dimensions.map((d) => d.id)));
  // compile every metric through Cube's SQL generation (0 errors)
  for (const m of reg.metrics) {
    const dr = await cubeDryRun(CUBE_URL, cubeToken(), {
      measures: [m.cubeMember],
      timeDimensions: [
        { dimension: `${m.cubeMember.split(".")[0]}.day`, granularity: "day", dateRange: RANGE },
      ],
    });
    expect(dr.error, m.id).toBeUndefined();
  }

  // (d) >= 3 rollups build and serve their query
  const rollups = [
    {
      member: "near_usage.daily_successful_tx_count",
      view: "near_usage",
      id: "near_daily_usage.daily_usage_rollup",
    },
    {
      member: "intents.oneclick_completed_swap_count",
      view: "intents",
      id: "intents_swaps.daily_status_rollup",
    },
    { member: "quotes.route_quote_attempt_count", view: "quotes", id: "quote_attempts.daily_route_rollup" },
    {
      member: "taxonomy.contract_interactions_by_taxonomy",
      view: "taxonomy",
      id: "contract_interactions.daily_taxonomy_rollup",
    },
  ];
  const usage: unknown[] = [];
  for (const r of rollups) {
    const res = await cubeLoad(CUBE_URL, cubeToken(), {
      measures: [r.member],
      timeDimensions: [{ dimension: `${r.view}.day`, granularity: "day", dateRange: RANGE }],
      cache: "must-revalidate",
    });
    const used = Object.values(res.usedPreAggregations ?? {});
    expect(
      used.map((u) => u.preAggregationId),
      r.member,
    ).toContain(r.id);
    usage.push({ query: r.member, usedPreAggregations: res.usedPreAggregations });
  }
  const built = await queryRows<{ name: string; rows: string }>(
    env.ch,
    "SELECT name, toString(total_rows) AS rows FROM system.tables WHERE database = 'nearesis_preagg' AND name NOT LIKE 'probe%' ORDER BY name",
  );
  expect(built.length).toBeGreaterThanOrEqual(3);

  // (e) METRICS.md lists every certified metric and equals the generator output
  const md = readFileSync(join(SERVICE_ROOT, "..", "..", "docs", "metrics", "METRICS.md"), "utf8");
  for (const m of certified) expect(md).toContain(`## ${m.id}`);
  expect(md).toBe(generateMetricsMd(reg));

  observe({
    testId: "S13",
    observed: `${certified.length} certified metrics with all ch.06 fields set; ${views.length} views and 0 public base cubes; /meta member set and per-measure meta equal the registry (${reg.metrics.length} measures, ${dims.length} dimensions); ${reg.metrics.length} dry-run compiles with 0 errors; ${usage.length} rollups built (${built.length} materialized tables) and each served its query; image ${PINNED}`,
    fixtureHash: baseline().digest,
    evidence: {
      image: PINNED,
      registryVersion: reg.semanticVersion,
      registryHash: reg.contentHash,
      validation: { metrics: reg.metrics.length, certified: certified.length, entriesWithMissingFields: 0 },
      views: views.map((v) => v.name),
      metaSha256: createHash("sha256").update(canonicalJson(meta)).digest("hex"),
      rollupUsage: usage,
      preAggregationTables: built,
    },
  });
});

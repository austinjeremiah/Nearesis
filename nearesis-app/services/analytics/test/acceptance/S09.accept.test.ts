import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, cubeLoad, queryRows } from "../../src/index.ts";
import { CUBE_URL, cubeToken, setupEnv, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const RANGE = ["2026-10-01T00:00:00.000", "2026-10-10T23:59:59.999"];
const REL_TOL = 1e-9;

interface Case {
  rollup: string;
  member: string;
  view: string;
  sql: string;
  exact: boolean;
}
const cases: Case[] = [
  {
    rollup: "near_daily_usage.daily_usage_rollup",
    member: "near_usage.daily_successful_tx_count",
    view: "near_usage",
    sql: "SELECT toString(block_date) AS d, toString(sum(successful_tx_count)) AS v FROM near_daily_usage FINAL GROUP BY d",
    exact: true,
  },
  {
    rollup: "intents_swaps.daily_status_rollup",
    member: "intents.oneclick_completed_swap_count",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(countIf(status = 'SUCCESS')) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    rollup: "quote_attempts.daily_route_rollup",
    member: "quotes.route_quote_availability",
    view: "quotes",
    sql: "SELECT toString(day) AS d, toString(countIf(attempt_class = 'OK') / count()) AS v FROM quote_attempts FINAL GROUP BY d",
    exact: false,
  },
  {
    rollup: "contract_interactions.daily_taxonomy_rollup",
    member: "taxonomy.uncategorized_share",
    view: "taxonomy",
    sql: "SELECT toString(block_date) AS d, toString(sumIf(interactions, segment_state = 'uncategorized') / sum(interactions)) AS v FROM contract_interactions FINAL GROUP BY d",
    exact: false,
  },
];

test("S09 pre-aggregation results equal raw results within the documented tolerance", async () => {
  const rows: unknown[] = [];
  for (const c of cases) {
    const res = await cubeLoad(CUBE_URL, cubeToken(), {
      measures: [c.member],
      timeDimensions: [{ dimension: `${c.view}.day`, granularity: "day", dateRange: RANGE }],
      cache: "must-revalidate",
    });
    expect(Object.keys(res.usedPreAggregations ?? {}), c.member).toContain(
      `nearesis_preagg.${c.rollup.replace(".", "_")}`,
    );
    const raw = new Map((await queryRows<{ d: string; v: string }>(env.ch, c.sql)).map((r) => [r.d, r.v]));
    expect(res.data).toHaveLength(raw.size);
    let maxRel = 0;
    for (const r of res.data) {
      const day = String(r[`${c.view}.day.day`]).slice(0, 10);
      const got = String(r[c.member]);
      const want = raw.get(day)!;
      if (c.exact) expect(got, `${c.member} ${day}`).toBe(want);
      else {
        const rel = Math.abs(Number(got) - Number(want)) / Math.max(1e-12, Math.abs(Number(want)));
        maxRel = Math.max(maxRel, rel);
        expect(rel, `${c.member} ${day}`).toBeLessThanOrEqual(REL_TOL);
      }
    }
    rows.push({
      rollup: c.rollup,
      member: c.member,
      days: raw.size,
      exact: c.exact,
      maxRelativeError: c.exact ? 0 : maxRel,
    });
  }
  // Rollup vs Cube-without-rollup (a dimension outside the rollup forces the raw path).
  const viaRollup = await cubeLoad(CUBE_URL, cubeToken(), {
    measures: ["intents.oneclick_completed_swap_count"],
    timeDimensions: [{ dimension: "intents.day", dateRange: RANGE }],
    cache: "must-revalidate",
  });
  const viaRaw = await cubeLoad(CUBE_URL, cubeToken(), {
    measures: ["intents.oneclick_completed_swap_count"],
    dimensions: ["intents.canonical_origin_asset"],
    timeDimensions: [{ dimension: "intents.day", dateRange: RANGE }],
    cache: "must-revalidate",
  });
  expect(Object.keys(viaRollup.usedPreAggregations ?? {})).toHaveLength(1);
  expect(Object.keys(viaRaw.usedPreAggregations ?? {})).toHaveLength(0);
  const sumRaw = viaRaw.data.reduce((a, r) => a + Number(r["intents.oneclick_completed_swap_count"]), 0);
  expect(String(sumRaw)).toBe(String(viaRollup.data[0]!["intents.oneclick_completed_swap_count"]));
  observe({
    testId: "S09",
    observed: `4 rollups each served their query and equal independent raw FINAL SQL per day (counts/sums exact, ratios within relative tolerance ${REL_TOL}); rollup total equals the non-rollup Cube path total (${sumRaw})`,
    fixtureHash: baseline().digest,
    evidence: {
      tolerance: { exact: "string equality", ratios: `relative <= ${REL_TOL}` },
      rollups: rows,
      rollupTotal: viaRollup.data[0]!["intents.oneclick_completed_swap_count"],
      rawPathTotal: sumRaw,
    },
  });
});

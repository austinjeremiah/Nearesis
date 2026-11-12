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
    rollup: "intents_swaps.daily_status_rollup",
    member: "intents.oneclick_volume_usd",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(sumIf(amount_in_usd, status = 'SUCCESS' AND amount_final = 1)) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    rollup: "intents_swaps.daily_asset_rollup",
    member: "intents.oneclick_amount_in_smallest_unit",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(sumIf(amount_in, status = 'SUCCESS' AND amount_final = 1)) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    rollup: "intents_swaps.daily_status_rollup",
    member: "intents.oneclick_completion_rate",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(countIf(status = 'SUCCESS') / count()) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: false,
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
    dimensions: ["intents.referral"], // referral is in no rollup: Cube must scan the table
    timeDimensions: [{ dimension: "intents.day", dateRange: RANGE }],
    cache: "must-revalidate",
  });
  expect(Object.keys(viaRollup.usedPreAggregations ?? {})).toHaveLength(1);
  expect(Object.keys(viaRaw.usedPreAggregations ?? {})).toHaveLength(0);
  const sumRaw = viaRaw.data.reduce((a, r) => a + Number(r["intents.oneclick_completed_swap_count"]), 0);
  expect(String(sumRaw)).toBe(String(viaRollup.data[0]!["intents.oneclick_completed_swap_count"]));
  // Per-asset slices come from the asset rollup too and must equal raw per (day, asset): amount is only meaningful per asset.
  const byAsset = await cubeLoad(CUBE_URL, cubeToken(), {
    measures: ["intents.oneclick_amount_in_smallest_unit", "intents.oneclick_volume_usd"],
    dimensions: ["intents.canonical_origin_asset"],
    timeDimensions: [{ dimension: "intents.day", granularity: "day", dateRange: RANGE }],
    cache: "must-revalidate",
  });
  expect(Object.keys(byAsset.usedPreAggregations ?? {})).toEqual([
    "nearesis_preagg.intents_swaps_daily_asset_rollup",
  ]);
  const rawAsset = new Map(
    (
      await queryRows<{ k: string; a: string; u: string }>(
        env.ch,
        `SELECT concat(toString(created_day), '|', canonical_origin_asset) AS k,
                toString(sumIf(amount_in, status = 'SUCCESS' AND amount_final = 1)) AS a,
                toString(sumIf(amount_in_usd, status = 'SUCCESS' AND amount_final = 1)) AS u
         FROM intents_swaps FINAL
         WHERE created_day >= '2026-10-01' AND created_day <= '2026-10-10' GROUP BY k`,
      )
    ).map((r) => [r.k, r]),
  );
  expect(byAsset.data).toHaveLength(rawAsset.size);
  for (const r of byAsset.data) {
    const k = `${String(r["intents.day.day"]).slice(0, 10)}|${String(r["intents.canonical_origin_asset"])}`;
    expect(String(r["intents.oneclick_amount_in_smallest_unit"]), k).toBe(rawAsset.get(k)!.a);
    expect(String(r["intents.oneclick_volume_usd"]), k).toBe(rawAsset.get(k)!.u);
  }
  observe({
    testId: "S09",
    observed: `7 rollup-served members (counts, USD volume, origin amount, completion rate, route, taxonomy, usage) each served their query and equal independent raw FINAL SQL per day (counts/sums exact, ratios within relative tolerance ${REL_TOL}); rollup total equals the non-rollup Cube path total (${sumRaw})`,
    fixtureHash: baseline().digest,
    evidence: {
      tolerance: { exact: "string equality", ratios: `relative <= ${REL_TOL}` },
      rollups: rows,
      perAssetRows: byAsset.data.length,
      rollupTotal: viaRollup.data[0]!["intents.oneclick_completed_swap_count"],
      rawPathTotal: sumRaw,
    },
  });
});

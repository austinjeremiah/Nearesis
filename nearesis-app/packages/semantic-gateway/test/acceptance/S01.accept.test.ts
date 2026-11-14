import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, canonicalJson, queryRows, sha256 } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

interface G {
  id: string;
  view: string;
  /** independent ClickHouse SQL (no Cube): day -> value */
  sql: string;
  exact: boolean;
}
const GOLD: G[] = [
  {
    id: "near.daily_successful_tx_count",
    view: "near_usage",
    sql: "SELECT toString(block_date) AS d, toString(sum(successful_tx_count)) AS v FROM near_daily_usage FINAL GROUP BY d",
    exact: true,
  },
  {
    id: "near.function_call_action_count",
    view: "near_usage",
    sql: "SELECT toString(block_date) AS d, toString(sum(function_call_actions)) AS v FROM near_daily_usage FINAL GROUP BY d",
    exact: true,
  },
  {
    id: "intents.oneclick_completed_swap_count",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(countIf(status = 'SUCCESS')) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    id: "intents.oneclick_total_swap_count",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(count()) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    id: "intents.oneclick_volume_usd",
    view: "intents",
    sql: "SELECT toString(created_day) AS d, toString(sumIf(amount_in_usd, status = 'SUCCESS' AND amount_final = 1)) AS v FROM intents_swaps FINAL GROUP BY d",
    exact: true,
  },
  {
    id: "intents.route_quote_availability",
    view: "quotes",
    sql: "SELECT toString(day) AS d, toString(countIf(attempt_class = 'OK') / count()) AS v FROM quote_attempts FINAL GROUP BY d",
    exact: false,
  },
  {
    id: "intents.route_quote_cost_bps",
    view: "quotes",
    sql: "SELECT toString(day) AS d, toString(avgIf(quote_cost_bps, attempt_class = 'OK')) AS v FROM quote_attempts FINAL GROUP BY d",
    exact: false,
  },
  {
    id: "research.uncategorized_share",
    view: "taxonomy",
    sql: "SELECT toString(block_date) AS d, toString(sumIf(interactions, segment_state = 'uncategorized') / sum(interactions)) AS v FROM contract_interactions FINAL GROUP BY d",
    exact: false,
  },
  {
    id: "prices.daily_close_price_usd",
    view: "prices",
    sql: "SELECT toString(day) AS d, toString(avgIf(close, quote_currency = 'usd')) AS v FROM price_candles FINAL GROUP BY d",
    exact: false,
  },
];

const same = (got: string | number | boolean | null, want: string, exact: boolean) => {
  if (exact) return Number(got) === Number(want); // exact decimals compared numerically after scale formatting below
  return Math.abs(Number(got) - Number(want)) <= 1e-9 * Math.max(1, Math.abs(Number(want)));
};

test("S01 known metrics match an independent SQL golden fixture", async () => {
  const gw = env.gateway();
  const golden: Record<string, Record<string, string>> = {};
  const compared: unknown[] = [];
  for (const g of GOLD) {
    const want = new Map((await queryRows<{ d: string; v: string }>(env.ch, g.sql)).map((r) => [r.d, r.v]));
    golden[g.id] = Object.fromEntries(want);
    const r = await gw.query(
      W1,
      ast({
        measures: [g.id],
        time: {
          field: `${g.view}.day`,
          from: "2026-10-01T00:00:00Z",
          to: "2026-10-11T00:00:00Z",
          grain: "day",
        },
      }),
    );
    expect(r.ok, g.id).toBe(true);
    if (!r.ok) continue;
    expect(r.envelope.rows).toHaveLength(10);
    expect(r.envelope.certification).toBe("certified");
    for (const row of r.envelope.rows) {
      const day = String(row[0]).slice(0, 10);
      expect(want.has(day), `${g.id} ${day}`).toBe(true);
      expect(
        same(row[1]!, want.get(day)!, g.exact),
        `${g.id} ${day}: gateway ${row[1]} golden ${want.get(day)}`,
      ).toBe(true);
    }
    compared.push({ metric: g.id, days: r.envelope.rows.length, exact: g.exact });
  }
  observe({
    testId: "S01",
    observed: `${GOLD.length} metrics x 10 days from the gateway (Cube) equal independent ClickHouse FINAL SQL (counts/sums exact, ratios/averages within 1e-9); envelopes certified`,
    fixtureHash: baseline().digest,
    evidence: { compared, goldenFixtureSha256: sha256(canonicalJson(golden)), golden },
  });
});

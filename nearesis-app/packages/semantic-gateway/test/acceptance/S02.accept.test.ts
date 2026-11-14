import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, queryRows } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const win = (field: string, grain: string) => ({
  field,
  from: "2026-10-01T00:00:00Z",
  to: "2026-10-11T00:00:00Z",
  grain,
});

test("S02 daily distinct signers are never summed into period uniques", async () => {
  const gw = env.gateway();
  const proxy = "near.distinct_signer_proxy";
  // refused at week and month
  for (const grain of ["week", "month"]) {
    const r = await gw.query(W1, ast({ measures: [proxy], time: win("near_usage.day", grain) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(r.error.reasonCode).toBe("PERIOD_UNIQUE_SUM_REFUSED");
      expect(r.error.nextAction).toContain("near.period_unique_signers");
    }
  }
  const active = await gw.query(
    W1,
    ast({ measures: ["near.active_contract_count"], time: win("near_usage.day", "month") }),
  );
  expect(!active.ok && active.error.reasonCode).toBe("PERIOD_UNIQUE_SUM_REFUSED");
  expect(gw.stats().executions).toBe(0);
  // allowed at day grain (each day is its own distinct count)
  const daily = await gw.query(W1, ast({ measures: [proxy], time: win("near_usage.day", "day") }));
  expect(daily.ok).toBe(true);
  if (!daily.ok) return;
  const dailySum = daily.envelope.rows.reduce((a, r) => a + Number(r[1]), 0);

  // period uniques come from count distinct over signer-day pairs
  const month = await gw.query(
    W1,
    ast({ measures: ["near.period_unique_signers"], time: win("near_signers.day", "month") }),
  );
  expect(month.ok).toBe(true);
  if (!month.ok) return;
  const trueMonth = (
    await queryRows<{ v: string }>(
      env.ch,
      "SELECT toString(uniqExact(signer_account_id)) AS v FROM near_signer_days FINAL",
    )
  )[0]!.v;
  expect(String(month.envelope.rows[0]![1])).toBe(trueMonth);
  expect(Number(trueMonth)).toBeLessThan(dailySum); // the wrong (summed) answer would overstate uniques
  const weeks = await gw.query(
    W1,
    ast({ measures: ["near.period_unique_signers"], time: win("near_signers.day", "week") }),
  );
  expect(weeks.ok).toBe(true);
  if (!weeks.ok) return;
  const trueWeeks = new Map(
    (
      await queryRows<{ w: string; v: string }>(
        env.ch,
        "SELECT toString(toMonday(block_date)) AS w, toString(uniqExact(signer_account_id)) AS v FROM near_signer_days FINAL GROUP BY w",
      )
    ).map((r) => [r.w, r.v]),
  );
  expect(weeks.envelope.rows).toHaveLength(trueWeeks.size);
  for (const r of weeks.envelope.rows) expect(String(r[1])).toBe(trueWeeks.get(String(r[0]).slice(0, 10)));
  observe({
    testId: "S02",
    observed: `distinct_signer_proxy and active_contract_count refused at week/month (422 PERIOD_UNIQUE_SUM_REFUSED, 0 executions) and allowed per day; period_unique_signers month = ${trueMonth} equals independent uniqExact, while summing the daily proxy would give ${dailySum}; weekly uniques match independent SQL per week`,
    fixtureHash: baseline().digest,
    evidence: { monthlyUnique: trueMonth, naiveDailySum: dailySum, weekly: Object.fromEntries(trueWeeks) },
  });
});

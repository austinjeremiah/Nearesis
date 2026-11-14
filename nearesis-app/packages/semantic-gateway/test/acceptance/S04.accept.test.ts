import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

test("S04 unauthorized dimension is denied without revealing member metadata", async () => {
  const gw = env.gateway();
  const denied = await gw.query(W1, ast({ dimensions: ["intents.referral"] }));
  expect(denied.ok).toBe(false);
  const restrictedMetric = await gw.query(
    W1,
    ast({
      measures: ["economics.externally_reported_revenue_usd"],
      time: {
        field: "economics.day",
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-11T00:00:00Z",
        grain: "day",
      },
    }),
  );
  const filterDenied = await gw.query(
    W1,
    ast({ filters: [{ member: "intents.referral", operator: "equals", values: ["x"] }] }),
  );
  const aggOnly = await gw.query(
    W1,
    ast({ measures: ["intents.oneclick_private_settlement_swap_count"], dimensions: ["intents.status"] }),
  );
  const results = { denied, restrictedMetric, filterDenied, aggOnly };
  for (const [k, r] of Object.entries(results)) {
    expect(r.ok, k).toBe(false);
    if (r.ok) continue;
    expect(r.status, k).toBe(403);
    const body = JSON.stringify(r.error);
    for (const leak of [
      "displayName",
      "Referral",
      "referral code",
      "Externally reported",
      "unit",
      "usd",
      "visibility",
      "restricted",
    ])
      expect(body, `${k} leaks ${leak}`).not.toContain(leak);
  }
  expect(gw.stats().executions).toBe(0);
  const catalog = JSON.stringify(await gw.discover(W1));
  expect(catalog).not.toContain("intents.referral");
  expect(catalog).not.toContain("externally_reported_revenue_usd");
  // aggregate-only metric without breakdown is allowed.
  const aggOk = await gw.query(W1, ast({ measures: ["intents.oneclick_private_settlement_swap_count"] }));
  expect(aggOk.ok).toBe(true);
  observe({
    testId: "S04",
    observed:
      "restricted dimension (select + filter), restricted metric and aggregate-only breakdown all denied 403 FORBIDDEN/MEMBER_NOT_VISIBLE|AGGREGATE_ONLY_BREAKDOWN_REFUSED with 0 executions; error bodies and catalog contain no member metadata; aggregate-only metric without breakdown still allowed",
    fixtureHash: baseline().digest,
    evidence: Object.fromEntries(
      Object.entries(results).map(([k, r]) => [
        k,
        r.ok ? 200 : { status: r.status, reasonCode: r.error.reasonCode, message: r.error.message },
      ]),
    ),
  });
});

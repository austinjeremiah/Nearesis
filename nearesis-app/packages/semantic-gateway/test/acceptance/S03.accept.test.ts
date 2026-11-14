import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

test("S03 unknown metric name is rejected 422 with no raw SQL fallback", async () => {
  const gw = env.gateway();
  const cases = [
    { name: "unknown metric", body: ast({ measures: ["intents.not_a_metric"] }), path: "measures[0]" },
    {
      name: "unknown metric with plausible name",
      body: ast({ measures: ["intents.oneclick_completed_swap_count_v2"] }),
      path: "measures[0]",
    },
    { name: "raw sql field", body: { ...ast(), sql: "SELECT * FROM intents_swaps" }, path: "sql" },
    {
      name: "sql-looking member",
      body: ast({ measures: ["x.y; DROP TABLE intents_swaps"] }),
      path: "measures[0]",
    },
  ];
  const rows: unknown[] = [];
  for (const c of cases) {
    const r = await gw.query(W1, c.body);
    expect(r.ok).toBe(false);
    if (r.ok) continue;
    expect(r.status).toBe(422);
    expect(r.error.errorCode).toBe("VALIDATION_FAILED");
    expect(r.error.details?.some((d) => d.path === c.path)).toBe(true);
    rows.push({
      case: c.name,
      status: r.status,
      reasonCode: r.error.reasonCode,
      path: r.error.details?.[0]?.path,
    });
  }
  const unknown = await gw.query(W1, ast({ measures: ["intents.not_a_metric"] }));
  expect(!unknown.ok && unknown.error.reasonCode).toBe("UNKNOWN_MEMBER");
  // No raw SQL path exists on the gateway surface and nothing was executed.
  expect(Object.keys(gw).sort()).toEqual(["audit", "discover", "query", "stats"]);
  expect(gw.stats().executions).toBe(0);
  // A valid query still executes (the corpus is not rejected wholesale).
  const ok = await gw.query(W1, ast());
  expect(ok.ok).toBe(true);
  expect(gw.stats().executions).toBe(1);
  observe({
    testId: "S03",
    observed: `4 invalid queries rejected with 422 (UNKNOWN_MEMBER / UNKNOWN_FIELD), 0 Cube executions for them, gateway surface = [${Object.keys(gw).sort()}]; valid control query executed once`,
    fixtureHash: baseline().digest,
    evidence: { cases: rows, executionsAfterNegatives: 0 },
  });
});

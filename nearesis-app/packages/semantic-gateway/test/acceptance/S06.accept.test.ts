import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline } from "@nearesis/analytics";
import { DEFAULT_POLICY } from "../../src/index.ts";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

const win = (from: string, to: string) => ({ field: "intents.day", from, to, grain: "day" });

test("S06 large date range is refused by the cost cap before any Cube execution", async () => {
  const gw = env.gateway({ policy: () => ({ ...DEFAULT_POLICY, maxEstimatedRows: 1000 }) });
  const big = await gw.query(W1, ast({ time: win("2016-01-01T00:00:00Z", "2026-01-01T00:00:00Z") }));
  expect(big.ok).toBe(false);
  if (!big.ok) {
    expect(big.status).toBe(402);
    expect(big.error.errorCode).toBe("BUDGET_EXCEEDED");
    expect(big.error.reasonCode).toBe("COST_CAP");
  }
  const huge = await gw.query(W1, ast({ time: win("1990-01-01T00:00:00Z", "2026-01-01T00:00:00Z") }));
  expect(!huge.ok && huge.error.errorCode).toBe("BUDGET_EXCEEDED");
  expect(!huge.ok && huge.error.reasonCode).toBe("WINDOW_TOO_LARGE");
  expect(gw.stats().executions).toBe(0);
  // Same policy, normal window passes.
  const ok = await gw.query(W1, ast());
  expect(ok.ok).toBe(true);
  expect(gw.stats().executions).toBe(1);
  observe({
    testId: "S06",
    observed:
      "10-year window: 402 BUDGET_EXCEEDED/COST_CAP; 36-year window: 402 BUDGET_EXCEEDED/WINDOW_TOO_LARGE; 0 Cube executions for both; the 10-day control window executed once under the same policy",
    fixtureHash: baseline().digest,
    evidence: {
      cap: 1000,
      executionsAfterRefusals: 0,
      controlExecutions: 1,
      refused: [big.ok ? null : big.error.reasonCode, huge.ok ? null : huge.error.reasonCode],
    },
  });
});

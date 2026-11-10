import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(baseline());
});
afterAll(async () => env.close());

test("S05 unit mismatch plot is refused unless an explicit indexed transform is requested", async () => {
  const gw = env.gateway();
  const mixed = ["intents.oneclick_completed_swap_count", "intents.oneclick_volume_usd"];
  const r = await gw.query(W1, ast({ measures: mixed }));
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(422);
    expect(r.error.reasonCode).toBe("UNIT_MISMATCH");
    expect(r.error.nextAction).toContain("index_100");
  }
  const bogus = await gw.query(
    W1,
    ast({ measures: ["intents.oneclick_completed_swap_count"], outputUnit: "usd" }),
  );
  expect(!bogus.ok && bogus.error.reasonCode).toBe("UNIT_MISMATCH");
  expect(gw.stats().executions).toBe(0);

  const sameUnit = await gw.query(
    W1,
    ast({ measures: ["intents.oneclick_completed_swap_count", "intents.oneclick_failed_swap_count"] }),
  );
  expect(sameUnit.ok).toBe(true);

  const indexed = await gw.query(W1, ast({ measures: mixed, outputUnit: "index_100" }));
  expect(indexed.ok).toBe(true);
  if (!indexed.ok) return;
  const cols = indexed.envelope.columns.slice(1);
  expect(cols.every((c) => c.unit === "index_100")).toBe(true);
  const firstRow = indexed.envelope.rows[0]!;
  expect(firstRow[1]).toBe(100);
  expect(firstRow[2]).toBe(100);
  observe({
    testId: "S05",
    observed:
      "swaps+usd on one axis refused 422 UNIT_MISMATCH with 0 executions; unsupported outputUnit refused; same-unit pair allowed; outputUnit=index_100 returns both columns unit index_100 with first observation = 100",
    fixtureHash: baseline().digest,
    evidence: {
      refusedReason: "UNIT_MISMATCH",
      executionsAfterRefusals: 0,
      indexedColumns: cols,
      indexedFirstRow: firstRow,
    },
  });
});

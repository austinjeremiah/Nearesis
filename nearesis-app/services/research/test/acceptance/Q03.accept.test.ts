import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q03 future data injected: the leakage detector blocks publication", () => {
  const m = runCase("Q03");
  expect(m.blocked).toBe(true);
  expect(m.codes).toContain("FUTURE_VALUE");
  expect(m.columns).toEqual(["x_lag2"]);
  expect(m.cleanFindings).toBe(0); // negative case: a clean dataset passes
  expect(m.cleanColumnsChecked).toBeGreaterThan(10);
  expect(m.overlapCodes).toContain("MECHANICAL_OVERLAP");
  expect(m.negativeLagCodes).toContain("NEGATIVE_LAG");
  observe({
    testId: "Q03",
    fixtureHash: m.fixtureHash,
    observed: `injected t+2 value into x_lag2: run blocked with ${m.codes.join(",")} on ${m.columns.join(",")}; clean dataset ${m.cleanColumnsChecked} columns, ${m.cleanFindings} findings; target-overlap -> ${m.overlapCodes.join(",")}; negative lag -> ${m.negativeLagCodes.join(",")}`,
    evidence: m,
  });
}, 600_000);

import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q06 top 1% account removal: the declared filter is applied consistently in all splits", () => {
  const m = runCase("Q06");
  expect(m.excluded).toEqual(m.independentExcluded);
  expect(m.excluded.length).toBe(m.expectedCount);
  for (const s of ["dev", "lockbox", "post"]) {
    expect(m.perSplit[s].rows).toBeGreaterThan(0);
    expect(m.perSplit[s].maxAbsDiff).toBeLessThan(1e-12);
  }
  expect(m.excludedAfterFutureChange).toEqual(m.excluded); // rule is set from the development window only
  expect(m.excludedAfterDevChange).not.toEqual(m.excluded); // negative: a development change does move the set
  expect(m.artifactSensitivity.status).toBe("OK");
  expect(m.artifactSensitivity.excluded).toEqual(m.excluded);
  observe({
    testId: "Q06",
    fixtureHash: m.fixtureHash,
    observed: `excluded ${m.excluded.join(",")} (independent recomputation identical); targets recomputed with that exclusion match in dev ${m.perSplit.dev.rows}, lockbox ${m.perSplit.lockbox.rows}, post ${m.perSplit.post.rows} rows (max diff ${m.perSplit.dev.maxAbsDiff}); future-period change leaves set unchanged, development change alters it`,
    evidence: m,
  });
});

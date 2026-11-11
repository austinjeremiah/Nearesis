import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q04 same seed and snapshot: values equal within the pinned numeric tolerance", () => {
  const m = runCase("Q04");
  expect(m.sameSeed.reproducible).toBe(true);
  expect(m.sameSeed.maxAbsDiff).toBeLessThanOrEqual(m.tolerance);
  expect(m.hashesEqual).toBe(true);
  expect(m.freshProcessRun).toBe(0);
  expect(m.freshProcessReproduce.reproducible).toBe(true);
  expect(m.freshProcessReproduce.maxAbsDiff).toBeLessThanOrEqual(m.tolerance);
  expect(m.differentSeedChangesCI).toBe(true); // negative: the seed is actually used
  observe({
    testId: "Q04",
    fixtureHash: m.fixtureHash,
    observed: `in-process rerun max abs diff ${m.sameSeed.maxAbsDiff}, section hashes equal=${m.hashesEqual}; fresh-process reproduce max abs diff ${m.freshProcessReproduce.maxAbsDiff} (tolerance ${m.tolerance}); different seed changes output=${m.differentSeedChangesCI}`,
    evidence: m,
  });
});

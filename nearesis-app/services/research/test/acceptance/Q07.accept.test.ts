import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q07 missing price date: correct missingness protocol and no hidden fill", () => {
  const m = runCase("Q07");
  expect(m.retNaNDays).toContain("2026-03-10");
  expect(m.retNaNDays).toContain("2026-03-11"); // the return that needs the missing close is also unknown
  expect(m.missingRetIsZeroOrFilled).toBe(false);
  expect(m.removedOrigins).toEqual(m.expectedRemoved);
  expect(m.dropsRecorded).toBe(4);
  expect(m.dropReasonsOnlyPriceCols).toBe(true);
  expect(m.targetUnchanged).toBe(true);
  expect(m.volumeDayIsNaN).toBe(true);
  expect(m.volumeNaNisZero).toBe(false);
  expect(m.nullPolicy).toBe("complete_case_no_fill_no_zero");
  expect(m.reportedDropCount).toBeGreaterThanOrEqual(m.dropsRecorded);
  observe({
    testId: "Q07",
    fixtureHash: m.fixtureHash,
    observed: `price 2026-03-10 absent: returns NaN on ${m.retNaNDays.slice(1).join(",")}; exactly origins ${m.removedOrigins.join(",")} dropped with reasons recorded; target series unchanged; missing volume day stays NaN (not 0); run status ${m.experimentStatus}`,
    evidence: m,
  });
}, 600_000);

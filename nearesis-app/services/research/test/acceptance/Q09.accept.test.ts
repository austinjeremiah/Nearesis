import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q09 empty holdout: INSUFFICIENT_DATA, not SUPPORTED", () => {
  const m = runCase("Q09");
  for (const k of ["emptyLockbox", "shortLockbox", "tooFewDevOrigins"]) {
    expect(m[k].status).toBe("INSUFFICIENT_DATA");
    expect(m[k].status).not.toBe("SUPPORTED");
  }
  expect(m.emptyLockbox.lockboxN).toBe(0);
  expect(m.shortLockbox.lockboxN).toBeLessThan(14);
  expect(m.emptyLockbox.devOrigins).toBeGreaterThan(300); // development win exists, holdout is what is missing
  expect(m.control.status).toBe("SUPPORTED"); // negative: with a proper holdout the same data is SUPPORTED
  observe({
    testId: "Q09",
    fixtureHash: m.fixtureHash,
    observed: `holdout 0 origins -> ${m.emptyLockbox.status}; 5 origins (<14) -> ${m.shortLockbox.status}; 70-day series -> ${m.tooFewDevOrigins.status}; same signal data with a 30-origin lockbox -> ${m.control.status}`,
    evidence: m,
  });
}, 600_000);

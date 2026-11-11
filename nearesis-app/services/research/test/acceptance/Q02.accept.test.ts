import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q02 no-signal fixture: no forced positive verdict and valid error metrics", () => {
  const m = runCase("Q02");
  expect(m.status).not.toBe("SUPPORTED");
  expect(m.status).toBe("UNSUPPORTED");
  expect(m.metricsFinite).toBe(true);
  expect(m.fdrRejectsMainSeed).toBe(0);
  expect(m.holdoutOpened).toBe(false);
  // negative control: across 20 independent no-signal datasets none is SUPPORTED
  expect(m.repeatSupported).toBe(0);
  expect(m.repeatFdrRejects).toBeLessThanOrEqual(1);
  observe({
    testId: "Q02",
    fixtureHash: m.fixtureHash,
    observed: `SYNTHETIC no-signal: status ${m.status}; FDR rejects ${m.fdrRejectsMainSeed}/9; baseline MAE ${m.losses.baseline.toFixed(4)}, intents ${m.losses.intents.toFixed(4)}; ${m.repeatSupported}/${m.repeatSeeds} repeat seeds SUPPORTED, ${m.repeatFdrRejects} FDR rejects total`,
    evidence: m,
  });
}, 600_000);

import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { runCase } from "./run-case.ts";

it("Q05 Oct 27 regime split: metrics and time windows are not mixed without labelling", () => {
  const m = runCase("Q05");
  for (const h of ["1", "7", "14"]) {
    const r = m.byHorizon[h];
    expect(r.devOrLockCrossesSplit).toBe(false);
    expect(r.postBeforeSplit).toBe(false);
    expect(r.postMinOrigin).toBe(m.regimeSplit);
    expect(r.straddleExcluded).toBe(r.expectedStraddle); // rows spanning the boundary are excluded, not mixed
    expect(r.regimes).toEqual(["post", "pre"]);
  }
  expect(m.artifactPostWindow.analysedSeparately).toBe(true);
  expect(m.postCheck.status).toBe("INSUFFICIENT_DATA"); // 18 post rows < min_train: labelled, not blended
  expect(m.postCheckLong.status).toBe("OK"); // enough post rows: evaluated on post-regime training data only
  expect(m.postCheckLong.n_origins).toBeLessThanOrEqual(m.postRowsLong - m.minTrain);
  observe({
    testId: "Q05",
    fixtureHash: m.fixtureHash,
    observed: `split ${m.regimeSplit}: dev/lockbox targets all earlier (max ${m.byHorizon["7"].lockMaxTarget}), post origins start ${m.byHorizon["7"].postMinOrigin}, straddle rows excluded 1/7/14 for h=1/7/14; post window ${m.artifactPostWindow.rows} rows reported ${m.postCheck.status}; 560-day control evaluates ${m.postCheckLong.n_origins} post origins separately`,
    evidence: m,
  });
}, 600_000);

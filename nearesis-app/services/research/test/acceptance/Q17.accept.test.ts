import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q17 the holdout lockbox opens once, after the freeze", () => {
  const m = runCase("Q17", "accept_cases_g07");
  try {
    const fz = frozenChecks(m);
    expect(
      fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact && fz.freezePrecedesFirstResult,
    ).toBe(true);
    // (a) during development 0 holdout rows are returned by any interface; each attempt is refused and audited
    expect(Object.keys(m.attempts)).toHaveLength(6);
    for (const a of Object.values(m.attempts) as { refused: boolean; rows: number }[]) {
      expect(a.refused).toBe(true);
      expect(a.rows).toBe(0);
    }
    expect(m.holdoutRowsReturnedToDevelopment).toBe(0);
    expect(m.auditRefusals).toBeGreaterThanOrEqual(4);
    expect(m.lockboxAttributeRefusals).toBeGreaterThanOrEqual(2);
    expect(m.lockboxFramesInDict).toEqual([]);
    expect(m.devMaxOrigin < m.holdoutStart).toBe(true);
    // (b) pre-opening metrics touch training and validation windows only
    expect(m.develop.touchedHoldout).toBe(false);
    expect(m.develop.maxTimestampTouched < m.develop.holdoutStart).toBe(true);
    // (c) opening needs an intact frozen hash; the event stores hash, time and actor
    expect(m.openWithBrokenFreeze.refused).toBe(true);
    expect(m.openEvent.preregistrationHash).toBe(m.frozen.documentHash);
    expect(m.openEvent.actor).toBe("auditor:primary");
    expect(typeof m.openEvent.at).toBe("string");
    // (d) second independent evaluation refused; tuning after opening flagged post_holdout and out of pre_registered
    expect(m.secondEvaluation.refused).toBe(true);
    expect(m.afterTuneAfterOpen.postHoldout).toBe(true);
    expect(m.afterTuneAfterOpen.flag).toBe(true);
    expect(["pre_registered", "out_of_sample", "independent_replication"]).not.toContain(
      m.afterTuneAfterOpen.strength,
    );
    // audit replay with the identical frozen configuration: allowed, recorded separately, never counted, never raises strength
    expect(m.replay.audit_replay).toBe(true);
    expect(m.replay.sameConfigHash).toBe(true);
    expect(m.replay.countsAsIndependentEvaluation).toBe(false);
    expect(m.replay.actor).not.toBe(m.final.actor);
    expect(m.replay.environment).not.toEqual({});
    expect(m.replay.withinTolerance).toBe(true);
    expect(m.replay.maxAbsDiff).toBeLessThanOrEqual(fz.params.q17.replayTolerance);
    const order = ["exploratory", "pre_registered", "out_of_sample", "independent_replication"];
    expect(order.indexOf(m.replay.strength)).toBeLessThanOrEqual(order.indexOf(m.final.strength));
    expect(m.evaluationCount.afterReplay).toBe(1);
    expect(m.evaluationCount.final).toBe(1);
    expect(m.evaluationCount.lockboxOpens).toBe(1);
    expect(m.evaluationCount.replays).toBe(1);
    // a replay with any altered frozen value is refused as a replay and treated as a prohibited second evaluation
    expect(m.alteredReplays.alteredSeed.refused).toBe(true);
    expect(m.alteredReplays.alteredThreshold.refused).toBe(true);
    // (e) sealed digest equal before and after, including after the replays
    expect(m.digest.equal).toBe(true);
    // (f) a below-minimum holdout is INSUFFICIENT_DATA (minimum read from the frozen file)
    expect(m.belowMinimum.status).toBe("INSUFFICIENT_DATA");
    expect(m.belowMinimum.n_origins).toBeLessThan(fz.params.q17.minHoldoutOrigins);
    expect(m.belowMinimum.required).toBe(fz.params.q17.minHoldoutOrigins);
    // negative controls are each caught by the assertion they target
    expect(m.negativeControls.leakyLoaderReturnedHoldoutRows).toBeGreaterThan(0); // would FAIL (a)
    expect(m.negativeControls.replayCountedAsEvaluation).toBeGreaterThan(1); // would FAIL (d)
    expect(m.negativeControls.alteredReplayAccepted).toBe(true); // would FAIL (d)
  } finally {
    observe({
      testId: "Q17",
      fixtureHash: m.fixtureHash,
      observed: `holdout ${m.holdoutRows} rows from ${m.holdoutStart}: 6 development-time access attempts refused, ${m.holdoutRowsReturnedToDevelopment} holdout rows returned; pre-open max timestamp ${m.develop.maxTimestampTouched}; opened once by ${m.openEvent.actor}; second evaluation refused=${m.secondEvaluation.refused}; audit replay within tolerance (max diff ${m.replay.maxAbsDiff}), count stays ${m.evaluationCount.final}; altered-config replays refused; digest equal=${m.digest.equal}; ${m.belowMinimum.n_origins}-origin holdout -> ${m.belowMinimum.status}; final holdout relative improvement ${m.final.result.relative_improvement}`,
      evidence: m,
    });
  }
}, 600_000);

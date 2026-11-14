import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q20 experiment manifest completeness and independent audit rerun", () => {
  const m = runCase("Q20", "accept_cases_g07");
  if (m.blocked) {
    observe({ testId: "Q20", observed: `blocked: ${m.blocked}`, blocked: m.blocked });
    return;
  }
  try {
    const fz = frozenChecks(m);
    expect(fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact).toBe(true);
    // (a) every registry field present, no placeholder, empty artifactHashes or null; the ch.08 example text fails
    expect(m.manifestKeys).toEqual([...fz.params.q20.manifestFields].sort());
    expect(m.manifestFailures).toEqual([]);
    expect(m.exampleManifestFailures.length).toBeGreaterThan(0);
    // (b) every artifactHashes entry matches the SHA-256 of its file
    expect(m.fileHashChecks.count).toBe(12);
    expect(m.fileHashChecks.allOk).toBe(true);
    // (c) environment B reproduces outputs within the frozen tolerance; canonical JSON hash-equal; chart vectors and table cells agree
    expect(m.tolerance).toBe(fz.params.q20.tolerance);
    expect(m.runDifference).toBeNull();
    expect(m.manifestDifference).toBeNull();
    expect(m.sectionHashesEqualAcrossEnvs).toBe(true);
    expect(m.chartVectorDifference).toBeNull();
    expect(m.thesisCellsEqual).toBe(true);
    expect(m.thesisCellCount).toBeGreaterThan(0);
    // (d) a perturbed value in B's output is detected, naming the first differing field
    expect(m.perturbationDetected?.field).toBe("/estimates/primary/delta_mae");
    // (e) environment lock hash and runtime versions are recorded; B is a separate checkout and virtualenv
    expect(m.environment.lockHashEqual).toBe(true);
    expect(m.environment.A.libraries).toEqual(m.environment.B.libraries);
    expect(m.environment.separateRoots).toBe(true);
    expect(m.environment.separateVirtualenvs).toBe(true);
    expect(m.environment.bPrefixInsideCleanDir).toBe(true);
    // (f) B is recorded as an audit replay with the same configuration hash and seeds, not an independent evaluation; a changed parameter is rejected
    expect(m.recordB.audit_replay).toBe(true);
    expect(m.recordB.countsAsIndependentEvaluation).toBe(false);
    expect(m.recordB.configHash).toBe(m.recordA.configHash);
    expect(m.recordB.seed).toBe(m.recordA.seed);
    expect(m.recordA.audit_replay).toBe(false);
    expect(m.changedParameterReplay.returncode).toBe(4);
    expect(m.changedParameterReplay.output.rejected).toBe(true);
  } finally {
    observe({
      testId: "Q20",
      fixtureHash: m.fixtureHash,
      observed: `manifest ${m.manifestKeys.length} fields, ${m.manifestFailures.length} failures (ch.08 example text: ${m.exampleManifestFailures.length}); ${m.fileHashChecks.count} artifact hashes match file SHA-256; clean checkout B with fresh venv (lock ${m.environment.A.lockHash.slice(0, 19)}) reproduced all ${Object.keys(m.chartVectors).length} chart vectors, ${m.thesisCellCount} THESIS table cells and section hashes equal=${m.sectionHashesEqualAcrossEnvs}; perturbation caught at ${m.perturbationDetected?.field}; B recorded audit_replay=${m.recordB.audit_replay} (not independent); seed+1 replay rejected (exit ${m.changedParameterReplay.returncode})`,
      evidence: {
        ...m,
        environment: {
          ...m.environment,
          A: { ...m.environment.A, platform: undefined },
          B: { ...m.environment.B, platform: undefined },
        },
      },
    });
  }
}, 900_000);

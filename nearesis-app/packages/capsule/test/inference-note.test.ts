import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildCapsule, verifyCapsule } from "../src/index.ts";
import { APP, LEGACY_RESEARCH_BUNDLE, SNAPSHOT, tmp } from "./helpers.ts";

const A002 = join(APP, "packages", "test-fixtures", "research", "signal-bundle-a002");

it("THESIS says significance is not claimed when the research run's inference is not validated", () => {
  const out = tmp();
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: out, researchBundleDir: A002 });
  const thesis = readFileSync(join(out, "exports", "THESIS.md"), "utf8");
  expect(thesis).toContain("Statistical significance is not claimed");
  expect(thesis).toContain("lower observed error is not evidence of a meaningful difference");
  const run = JSON.parse(readFileSync(join(A002, "research_run.json"), "utf8"));
  expect(run.estimates.inferenceSummary.primaryStatisticalClaim).toBe("not_supported");
  expect(run.estimates.primary.inference.conclusion.state).toBe("comparison_method_not_validated");
});

it("a run without an inference summary keeps the original thesis wording", () => {
  const out = tmp();
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: out, researchBundleDir: LEGACY_RESEARCH_BUNDLE });
  expect(readFileSync(join(out, "exports", "THESIS.md"), "utf8")).not.toContain(
    "Statistical significance is not claimed",
  );
});

it("a capsule pinned to the legacy research method reports a named method-version mismatch, not a silent difference", async () => {
  const out = tmp();
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: out, researchBundleDir: LEGACY_RESEARCH_BUNDLE });
  expect(m.research?.methodRevision).toBe("a001");
  const rep = await verifyCapsule(out, { research: "reproduce", wasm: "skip" });
  expect(rep.status).toBe("mismatch");
  const f = rep.failures.find((x) => x.kind === "METHOD_VERSION_MISMATCH");
  expect(f?.detail).toContain("revision a001");
  expect(f?.detail).toContain("revision a002");
  expect(rep.failures.some((x) => x.kind === "RESEARCH_NOT_REPRODUCIBLE")).toBe(false);
}, 120_000);

it("the current research bundle pins revision a002 and reproduces", async () => {
  const out = tmp();
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: out, researchBundleDir: A002 });
  expect(m.research?.methodRevision).toBe("a002");
  const rep = await verifyCapsule(out, { research: "reproduce", wasm: "skip" });
  expect(rep.checks).toContain("researchReproduction");
}, 120_000);

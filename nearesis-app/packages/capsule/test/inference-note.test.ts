import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildCapsule } from "../src/index.ts";
import { APP, RESEARCH_BUNDLE, SNAPSHOT, tmp } from "./helpers.ts";

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
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: out, researchBundleDir: RESEARCH_BUNDLE });
  expect(readFileSync(join(out, "exports", "THESIS.md"), "utf8")).not.toContain(
    "Statistical significance is not claimed",
  );
});

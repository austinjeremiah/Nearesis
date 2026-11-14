import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ResearchRunArtifact } from "@nearesis/contracts";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../packages/test-fixtures/research");

for (const [name, status] of [
  ["signal-bundle", "SUPPORTED"],
  ["nosignal-bundle", "UNSUPPORTED"],
] as const) {
  it(`${name} parses against the ResearchRunArtifact contract`, () => {
    const a = ResearchRunArtifact.parse(
      JSON.parse(readFileSync(resolve(dir, name, "research_run.json"), "utf8")),
    );
    expect(a.status).toBe(status);
    expect(a.claimScope).toBe("synthetic_fixture_only_no_live_claim");
    expect(a.inputSnapshot.label).toBe("SYNTHETIC");
  });
}

it("rejects an artifact with an unknown status", () => {
  const a = JSON.parse(readFileSync(resolve(dir, "signal-bundle", "research_run.json"), "utf8"));
  expect(ResearchRunArtifact.safeParse({ ...a, status: "PROVEN" }).success).toBe(false);
});

it("inference record: a significance claim requires VALID status", async () => {
  const { ResearchInferenceRecord } = await import("@nearesis/contracts");
  const base = {
    method: {
      id: "wpe_fixed_m_daniell",
      version: "fixed-smoothing-dm/1.0.0",
      label: "post_hoc_methodological_correction",
      role: "primary",
    },
    status: "METHOD_NOT_VALIDATED",
    nested: true,
    horizon: 1,
    n_origins: 80,
    mean_diff: 0.1,
    alpha: 0.05,
    sided: "two",
    sensitivity_methods: [],
    calibration_reference: null,
    significance_claim_allowed: false,
    limitations: [],
    conclusion: {
      state: "comparison_method_not_validated",
      observed_candidate_lower_error: true,
      statistically_meaningful_difference: false,
      causal_claim: "excluded",
    },
  };
  expect(ResearchInferenceRecord.safeParse(base).success).toBe(true);
  expect(ResearchInferenceRecord.safeParse({ ...base, significance_claim_allowed: true }).success).toBe(
    false,
  );
  expect(
    ResearchInferenceRecord.safeParse({ ...base, status: "VALID", significance_claim_allowed: true }).success,
  ).toBe(true);
});

it("amendment 002 bundles parse and carry a non-valid inference record for the nested primary comparison", () => {
  for (const name of ["signal-bundle-a002", "nosignal-bundle-a002"]) {
    const a = ResearchRunArtifact.parse(
      JSON.parse(readFileSync(resolve(dir, name, "research_run.json"), "utf8")),
    );
    const inf = (
      a.estimates.primary as { inference?: { status: string; significance_claim_allowed: boolean } }
    ).inference;
    expect(inf?.status).toBe("METHOD_NOT_VALIDATED");
    expect(inf?.significance_claim_allowed).toBe(false);
  }
});

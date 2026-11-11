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

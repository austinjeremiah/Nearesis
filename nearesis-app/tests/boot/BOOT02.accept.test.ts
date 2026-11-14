import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { observe } from "@nearesis/acceptance";
import { expect, it } from "vitest";
import { PATTERNS, loadAllow, scanRepo } from "../../scripts/security/secret-scan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const allowPath = join(here, "..", "..", "scripts", "security", "secret-scan.allow.json");

it("BOOT02: secret scanner finds 0 committed credential values", () => {
  const allow = loadAllow(allowPath);
  const findings = scanRepo(repoRoot, allow);
  // Report names/locations only; never values.
  expect(findings.map((f) => `${f.kind}:${f.name}:${f.file}:${f.line}`)).toEqual([]);
  observe({
    testId: "BOOT02",
    observed: `scanned git-tracked files with ${PATTERNS.length} patterns plus .env value comparison: ${findings.length} findings, ${allow.length} allowlist entries`,
    fixtureHash: createHash("sha256").update(readFileSync(allowPath)).digest("hex"),
    evidence: {
      findings: findings.length,
      patterns: PATTERNS.map((p) => p.name),
      allowlistEntries: allow.length,
    },
  });
});

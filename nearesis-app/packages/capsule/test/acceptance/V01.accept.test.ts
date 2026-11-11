import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildCapsule, canonicalSha256, scrubbedEnv, sha256Hex } from "../../src/index.ts";
import { PKG, RESEARCH_BUNDLE, SNAPSHOT, tmp, treeHashes } from "../helpers.ts";

/** V01 (ch.16): rebuild offline with no JWT; report, chart and model outputs reproduced from frozen data. */
it("V01: offline rebuild from the frozen snapshot, no JWT, no network, byte-identical outputs", () => {
  const original = tmp("v01-a-");
  const rebuilt = tmp("v01-b-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: original, researchBundleDir: RESEARCH_BUNDLE });

  // Rebuild in a child process: scrubbed environment (no JWT or secret), and a preload that throws on any network use.
  const env = scrubbedEnv();
  for (const k of Object.keys(env)) expect(k).not.toMatch(/JWT|TOKEN|SECRET|KEY|PASSWORD/i);
  const r = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      join(PKG, "src", "no-network.mjs"),
      join(PKG, "src", "cli.ts"),
      "rebuild",
      "--snapshot",
      SNAPSHOT,
      "--out",
      rebuilt,
      "--research-bundle",
      RESEARCH_BUNDLE,
      "--expect",
      join(original, "manifest.json"),
    ],
    { cwd: PKG, env, encoding: "utf8", timeout: 280_000 },
  );
  expect(r.status, r.stderr.slice(0, 600)).toBe(0);
  const out = JSON.parse(r.stdout) as {
    status: string;
    matchesExpected: boolean;
    capsuleHash: string;
    checks: string[];
  };

  // Network is really blocked in the child: prove the preload throws, so a networked rebuild could not have passed.
  const probe = spawnSync(
    process.execPath,
    [
      "--import",
      join(PKG, "src", "no-network.mjs"),
      "-e",
      "try{fetch('http://127.0.0.1:9')}catch(e){console.log(e.message)}",
    ],
    { encoding: "utf8", env },
  );
  expect(probe.stdout).toContain("NETWORK_BLOCKED");

  const a = treeHashes(original);
  const b = treeHashes(rebuilt);
  expect(b).toEqual(a);
  expect(out.status).toBe("reproduced");
  expect(out.matchesExpected).toBe(true);
  expect(out.capsuleHash).toBe(m.capsuleHash);
  expect(out.checks).toContain("researchReproduction");
  expect(out.checks).toContain("wasmtimeLocalCrossCheck");
  for (const f of [
    "exports/THESIS.md",
    "exports/memo.pdf",
    "exports/site/index.html",
    "computation/results.json",
    "research/research_run.json",
  ])
    expect(b[f]).toBe(a[f]);

  observe({
    testId: "V01",
    observed: `Rebuilt in a child process with a scrubbed env (no JWT/secret keys) and network use blocked: ${Object.keys(a).length} files byte-identical (${Object.keys(a).length}/${Object.keys(b).length}); capsuleHash ${m.capsuleHash.slice(0, 16)} matches; checks=${out.checks.join(",")}. Label SYNTHETIC; local verification only.`,
    fixtureHash: sha256Hex(Buffer.from(m.snapshot.dataHash)),
    evidence: {
      capsuleHash: m.capsuleHash,
      resultsSha256: m.computation.resultsSha256,
      files: Object.keys(a).length,
      treeHash: canonicalSha256(a),
      checks: out.checks,
      label: "SYNTHETIC",
    },
  });
}, 300_000);

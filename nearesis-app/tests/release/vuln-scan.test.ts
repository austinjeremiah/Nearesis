/**
 * Vulnerability policy and the real trivy scanner (ch.12/ch.17, SEC05/SEC11/N06). Policy cases are pure. The scanner cases
 * run the pinned trivy over planted artifacts: a vulnerable lockfile and a secret-bearing file must be rejected by the same
 * code path the release uses, a clean file must pass.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  acceptanceProblem,
  MANDATORY_IMAGES,
  evaluatePolicy,
  readAcceptances,
  scanRelease,
  plantedArtifactDir,
  readWaivers,
  scanFs,
  scanImage,
  scannerInfo,
  waiverProblem,
} from "../../scripts/release/vuln-scan.ts";
import type { Acceptance, Finding, Waiver } from "../../scripts/release/vuln-scan.ts";

const NOW = new Date("2026-11-12T00:00:00Z");
const vuln = (o: Partial<Finding> & { id: string }): Finding =>
  ({
    kind: "vulnerability",
    pkg: "pkg",
    installed: "1.0.0",
    fixed: null,
    severity: "HIGH",
    status: "affected",
    target: "t",
    ...o,
  }) as Finding;
const waiver = (o: Partial<Waiver> = {}): Waiver => ({
  waiverId: "W1",
  findingId: "CVE-1",
  severity: "HIGH",
  rationale: "documented: not reachable from any network path",
  signerKind: "human",
  signerId: "owner",
  reviewerId: "reviewer",
  independentReviewRef: "REVIEW-1",
  expiresAt: "2026-12-31T00:00:00Z",
  ...o,
});

describe("policy", () => {
  it("blocks CRITICAL, HIGH with a fix, and HIGH without a fix that has no acceptance", () => {
    const v = evaluatePolicy(
      [
        vuln({ id: "C", severity: "CRITICAL" }),
        vuln({ id: "H-fix", fixed: "2.0.0" }),
        vuln({ id: "H-nofix" }),
        vuln({ id: "M", severity: "MEDIUM" }),
      ],
      [],
      NOW,
      { acceptances: [] },
    );
    expect(v.verdict).toBe("BLOCK");
    expect(v.blockers.map((b) => `${b.rule}:${b.id}`)).toEqual([
      "CRITICAL:C",
      "HIGH_WITH_FIX:H-fix",
      "HIGH_NO_FIX_UNACCEPTED:H-nofix",
    ]);
    expect(v.informational.highNoFix).toBe(1);
    expect(evaluatePolicy([vuln({ id: "H-nofix" })], [], NOW, { acceptances: [] }).verdict).toBe("BLOCK");
  });
  it("blocks any secret", () => {
    const v = evaluatePolicy(
      [{ kind: "secret", id: "aws-access-key-id", severity: "CRITICAL", target: "f", line: 3 }],
      [],
      NOW,
    );
    expect(v.blockers[0]?.rule).toBe("SECRET");
  });
  it("a valid SEC22 waiver clears a HIGH with a fix; expired, self-reviewed, agent-signed and short ones do not; a critical is never waivable", () => {
    const h = [vuln({ id: "CVE-1", fixed: "2" })];
    expect(evaluatePolicy(h, [waiver()], NOW)).toMatchObject({
      verdict: "PASS",
      waived: [{ waiverId: "W1" }],
    });
    const bad: Array<[string, Waiver]> = [
      ["expired", waiver({ expiresAt: "2026-11-01T00:00:00Z" })],
      ["no expiry", waiver({ expiresAt: "" })],
      ["self review", waiver({ reviewerId: "owner" })],
      ["agent signer", waiver({ signerKind: "agent" })],
      ["short rationale", waiver({ rationale: "ok" })],
      ["no review ref", waiver({ independentReviewRef: "" })],
    ];
    for (const [name, w] of bad) {
      expect(waiverProblem(w, NOW), name).not.toBeNull();
      const v = evaluatePolicy(h, [w], NOW);
      expect(v.verdict, name).toBe("BLOCK");
      expect(v.invalidWaivers[0]?.waiverId).toBe("W1");
    }
    const c = evaluatePolicy(
      [vuln({ id: "CVE-1", severity: "CRITICAL", fixed: "2" })],
      [waiver({ severity: "CRITICAL" })],
      NOW,
    );
    expect(c.verdict).toBe("BLOCK");
    expect(c.invalidWaivers[0]?.reason).toMatch(/never waivable/);
    // a waiver for another package or id does nothing
    expect(evaluatePolicy(h, [waiver({ findingId: "CVE-2" })], NOW).verdict).toBe("BLOCK");
    expect(evaluatePolicy(h, [waiver({ package: "other" })], NOW).verdict).toBe("BLOCK");
  });
  it("the committed waiver file holds no entry that is expired or invalid", () => {
    for (const w of readWaivers()) expect(waiverProblem(w, new Date())).toBeNull();
  });
});

const acc = (o: Partial<Acceptance> = {}): Acceptance => ({
  acceptanceId: "A1",
  cve: "CVE-9",
  package: "pkg",
  artifact: "api",
  justification: "no fix upstream; not reachable from the request path",
  acceptedBy: { kind: "human", id: "owner" },
  reviewer: "reviewer",
  createdAt: "2026-11-10T00:00:00Z",
  expiresAt: "2026-12-05T00:00:00Z",
  ...o,
});

describe("risk-acceptance register for HIGH without a fix", () => {
  const f = [vuln({ id: "CVE-9", target: "img (debian 12)" })];
  const run = (a: Acceptance[], findings = f, artifact = "api") =>
    evaluatePolicy(findings, [], NOW, { artifact, acceptances: a });
  it("a valid acceptance for the exact cve, package and image passes", () => {
    const v = run([acc()]);
    expect(v.verdict).toBe("PASS");
    expect(v.accepted).toEqual([{ id: "CVE-9", acceptanceId: "A1", expiresAt: "2026-12-05T00:00:00Z" }]);
    expect(v.informational.highNoFixAccepted).toBe(1);
    // a lockfile path also matches via the finding target
    expect(run([acc({ artifact: "img (debian 12)" })], f, "lockfiles").verdict).toBe("PASS");
  });
  it("negative controls: wrong cve, package, artifact, or no entry block", () => {
    expect(run([]).verdict).toBe("BLOCK");
    expect(run([acc({ cve: "CVE-0" })]).verdict).toBe("BLOCK");
    expect(run([acc({ package: "other" })]).verdict).toBe("BLOCK");
    expect(run([acc({ artifact: "worker" })]).verdict).toBe("BLOCK");
  });
  it("an expired acceptance blocks and is reported", () => {
    const v = run([acc({ createdAt: "2026-10-10T00:00:00Z", expiresAt: "2026-11-05T00:00:00Z" })]);
    expect(v.verdict).toBe("BLOCK");
    expect(v.invalidAcceptances).toEqual([{ acceptanceId: "A1", reason: "expired" }]);
  });
  it("a validity longer than 30 days is rejected", () => {
    const longer = acc({ expiresAt: "2026-12-11T00:00:00Z" });
    expect(acceptanceProblem(longer, NOW)).toMatch(/exceeds 30 days/);
    expect(run([longer]).verdict).toBe("BLOCK");
    expect(acceptanceProblem(acc({ expiresAt: "2026-12-10T00:00:00Z" }), NOW)).toBeNull();
  });
  it("agent acceptor, self-review, short justification and missing dates are rejected", () => {
    const bad: Array<[string, Acceptance]> = [
      ["agent", acc({ acceptedBy: { kind: "agent", id: "a" } })],
      ["self review", acc({ reviewer: "owner" })],
      ["no reviewer", acc({ reviewer: "" })],
      ["short", acc({ justification: "ok" })],
      ["no expiry", acc({ expiresAt: "" })],
      ["no created", acc({ createdAt: "" })],
      ["future", acc({ createdAt: "2026-11-20T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" })],
    ];
    for (const [name, a] of bad) {
      expect(acceptanceProblem(a, NOW), name).not.toBeNull();
      expect(run([a]).verdict, name).toBe("BLOCK");
    }
  });
  it("a fix becoming available voids the acceptance", () => {
    const v = run([acc()], [vuln({ id: "CVE-9", fixed: "2.0.0", target: "t" })]);
    expect(v.verdict).toBe("BLOCK");
    expect(v.blockers[0]?.rule).toBe("HIGH_WITH_FIX");
    expect(v.accepted).toEqual([]);
  });
  it("a CRITICAL can never be accepted", () => {
    const v = run([acc()], [vuln({ id: "CVE-9", severity: "CRITICAL" })]);
    expect(v.verdict).toBe("BLOCK");
    expect(v.blockers[0]?.rule).toBe("CRITICAL");
  });
  it("the committed register holds no invalid entry (owner creates entries; none are created by agents)", () => {
    for (const a of readAcceptances()) expect(acceptanceProblem(a, new Date())).toBeNull();
  });
});

const info = scannerInfo();
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe.skipIf(!info)("real trivy scan of planted artifacts (negative control)", () => {
  it("the scanner is the pinned version and binary and has a vulnerability DB", () => {
    expect(info!.pinOk).toBe(true);
    expect(info!.dbUpdatedAt).toMatch(/^20\d\d-/);
  });
  it("a planted vulnerable lockfile and a planted secret are rejected; a clean tree passes", () => {
    const dir = plantedArtifactDir();
    tmp.push(dir);
    const planted = scanFs(dir);
    const v = evaluatePolicy(planted, []);
    expect(v.verdict).toBe("BLOCK");
    expect(v.blockers.some((b) => b.rule === "HIGH_WITH_FIX" || b.rule === "CRITICAL")).toBe(true);
    expect(v.blockers.some((b) => b.rule === "SECRET")).toBe(true);
    const clean = mkdtempSync(join(tmpdir(), "vuln-clean-"));
    tmp.push(clean);
    writeFileSync(
      join(clean, "package-lock.json"),
      JSON.stringify({ name: "c", lockfileVersion: 3, packages: { "": { name: "c", version: "1.0.0" } } }),
    );
    expect(evaluatePolicy(scanFs(clean), [], new Date(), { acceptances: [] }).verdict).toBe("PASS");
  });
  it.skipIf(!process.env.NEARESIS_ACCEPT_LIVE)(
    "a planted vulnerable and secret-bearing local image is rejected",
    () => {
      const dir = plantedArtifactDir();
      tmp.push(dir);
      const ctx = mkdtempSync(join(tmpdir(), "vuln-img-"));
      tmp.push(ctx);
      mkdirSync(join(ctx, "app"));
      spawnSync("cp", ["-R", `${dir}/.`, join(ctx, "app")]);
      // images are scanned by installed package metadata (node_modules/*/package.json), not by lockfiles
      mkdirSync(join(ctx, "app", "node_modules", "decode-uri-component"), { recursive: true });
      writeFileSync(
        join(ctx, "app", "node_modules", "decode-uri-component", "package.json"),
        JSON.stringify({ name: "decode-uri-component", version: "0.2.2", license: "MIT" }),
      );
      writeFileSync(join(ctx, "Dockerfile"), "FROM scratch\nCOPY app /app\n");
      const tag = "nearesis-vuln-negative-control:planted";
      const b = spawnSync("docker", ["build", "-q", "-t", tag, ctx], { encoding: "utf8" });
      expect(b.status, b.stderr).toBe(0);
      try {
        const v = evaluatePolicy(scanImage(tag), []);
        expect(v.verdict).toBe("BLOCK");
        expect(v.blockers.some((x) => x.rule === "SECRET")).toBe(true);
        expect(v.blockers.some((x) => x.rule !== "SECRET")).toBe(true);
      } finally {
        spawnSync("docker", ["rmi", "-f", tag]);
      }
    },
    300_000,
  );
});

describe("the agent sandbox image is mandatory in the release scan", () => {
  it("names api, worker, web and sandbox; a scan that lacks the sandbox image BLOCKs and lists it", () => {
    expect([...MANDATORY_IMAGES]).toEqual(["api", "worker", "web", "sandbox"]);
    if (!scannerInfo()) return;
    const dir = mkdtempSync(join(tmpdir(), "vuln-empty-"));
    try {
      const r = scanRelease({ dir, images: {} });
      expect(r.status).toBe("RAN");
      if (r.status !== "RAN") return;
      expect(r.verdict).toBe("BLOCK");
      expect(r.missingMandatory).toEqual(["api", "worker", "web", "sandbox"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

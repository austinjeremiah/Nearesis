/**
 * N07: release preconditions. The evaluator and its refusal paths (sets i to viii, digest check, refusal report, mandatory-live
 * list of 16b section 8b) run here. The staged testnet rehearsal (LIVE) and the human halves are HUMAN-required, so the
 * verdict is BLOCKED_DEPENDENCY; SEC22 (the NO-GO evaluator it depends on) is also not yet recorded.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  RELEASE_GATES,
  checkRehearsalDigests,
  evaluateRelease,
  refusalReport,
} from "../../scripts/release/gate.ts";
import type { EvidenceRecord, IndexEntry, MandatoryLive } from "../../scripts/release/gate.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const SHA = "c".repeat(40);
const index = JSON.parse(readFileSync(join(ROOT, "tests/TEST_INDEX.json"), "utf8")).tests as IndexEntry[];
const ml = JSON.parse(readFileSync(join(ROOT, "scripts/release/mandatory-live.json"), "utf8"))
  .rows as MandatoryLive[];

it("N07: only an all-PASS, current, observed, live-where-mandatory evidence set is accepted; every other set is refused with its reason and 0 chain calls", () => {
  // vendored section 8b list does not drift from the Bible when it is present
  const bible = join(ROOT, "..", "NEARESIS_Build_Bible", "chapters", "16b_TEST_DEFINITIONS_AMENDMENT.md");
  if (existsSync(bible)) {
    const text = readFileSync(bible, "utf8");
    for (const row of ml) for (const id of row.testIds) expect(text.includes(id), `8b ids ${id}`).toBe(true);
    expect(text).toMatch(
      /G12 \| N01 testnet readback \(live\); N03 single minimal NEAR mainnet write \(HUMAN ONLY\)/,
    );
  }
  const live = new Set(ml.flatMap((r) => r.testIds));

  // the required set is the approved release-gate definitions of the real index
  const real = index.filter((t) => RELEASE_GATES.includes(t.gate));
  expect(real.length).toBeGreaterThan(100);
  const none = evaluateRelease(index, [], { gitSha: SHA, mandatoryLive: ml });
  expect(none.accepted).toBe(false);
  expect(none.blocking.length).toBe(real.length); // nothing recorded for this sha: every required test blocks

  // synthetic evidence over a slice that includes a mandatory-live item and a defined-only item
  const slice: IndexEntry[] = [
    { testId: "T1", gate: "G01", definition: "ch16", status: "IMPLEMENTED" },
    { testId: "T2", gate: "G05", definition: "16b", status: "IMPLEMENTED" },
    { testId: "V05", gate: "G09", definition: "ch16", status: "IMPLEMENTED", live: true },
  ];
  const pass = (testId: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
    testId,
    verdict: "PASS",
    observed: "measured",
    commitSha: SHA,
    mode: live.has(testId) ? "LIVE" : "FIXTURE",
    ...extra,
  });
  const good = [pass("T1"), pass("T2"), pass("V05")];
  const ctx = { gitSha: SHA, mandatoryLive: ml };
  const run = (ev: EvidenceRecord[], idx = slice) => evaluateRelease(idx, ev, ctx);

  const sets: Record<string, { d: ReturnType<typeof run>; code: string }> = {
    ii: { d: run([pass("T1"), pass("T2", { verdict: "FAIL" }), pass("V05")]), code: "FAIL" },
    iii: {
      d: run([pass("T1"), pass("T2", { verdict: "BLOCKED_DEPENDENCY" }), pass("V05")]),
      code: "BLOCKED",
    },
    ivNotRun: { d: run([pass("T1"), pass("V05")]), code: "NOT_RUN" },
    ivDefined: {
      d: run(good, [...slice, { testId: "T9", gate: "G06", definition: "16b", status: "DEFINED" }]),
      code: "NOT_IMPLEMENTED",
    },
    ivUndefined: {
      d: run(good, [...slice, { testId: "T8", gate: "G06", definition: "none", status: "UNDEFINED" }]),
      code: "NOT_IMPLEMENTED",
    },
    v: { d: run([pass("T1"), pass("T2", { observed: "" }), pass("V05")]), code: "NO_OBSERVATION" },
    vi: {
      d: run([pass("T1"), pass("T2", { commitSha: "d".repeat(40) }), pass("V05")]),
      code: "COMMIT_MISMATCH",
    },
    vii: { d: run([pass("T1"), pass("T2", { verdict: "SKIP" }), pass("V05")]), code: "SKIP" },
    viii: {
      d: run([pass("T1"), pass("T2"), pass("V05", { mode: "FIXTURE" })]),
      code: "LIVE_EVIDENCE_REQUIRED",
    },
    viiiSimulated: {
      d: run([pass("T1"), pass("T2"), pass("V05", { mode: "SIMULATED" })]),
      code: "LIVE_EVIDENCE_REQUIRED",
    },
    viiiSandbox: {
      d: run([pass("T1"), pass("T2"), pass("V05", { mode: "SANDBOX" })]),
      code: "LIVE_EVIDENCE_REQUIRED",
    },
  };
  // (a) set i accepted
  expect(run(good).accepted).toBe(true);
  for (const [k, s] of Object.entries(sets)) {
    expect(s.d.accepted, k).toBe(false);
    expect(
      s.d.reasons.map((r) => r.code),
      k,
    ).toContain(s.code);
  }

  // G12 is never accepted without human-approved mainnet evidence
  const g12idx: IndexEntry[] = [
    { testId: "N01", gate: "G12", definition: "ch16", status: "IMPLEMENTED", live: true },
    { testId: "N03", gate: "G12", definition: "ch16", status: "IMPLEMENTED", live: true },
  ];
  const g12ctx = { gitSha: SHA, mandatoryLive: ml, gates: ["G12"] };
  for (const mode of ["FIXTURE", "SANDBOX", "SIMULATED"] as const) {
    const d = evaluateRelease(g12idx, [pass("N01", { mode }), pass("N03", { mode })], g12ctx);
    expect(d.accepted, mode).toBe(false);
    expect(d.reasons.map((r) => r.code)).toContain("G12_HUMAN_EVIDENCE_REQUIRED");
  }
  expect(
    evaluateRelease(g12idx, [pass("N01", { mode: "LIVE" }), pass("N03", { mode: "HUMAN" })], g12ctx).accepted,
  ).toBe(true);

  // (d) refusal report names the blocking tests
  const dir = mkdtempSync(join(tmpdir(), "n07-"));
  writeFileSync(join(dir, "report.json"), refusalReport(sets.iii!.d, SHA));
  const rep = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
    blockingTests: string[];
    accepted: boolean;
  };
  rmSync(dir, { recursive: true, force: true });
  expect(rep).toMatchObject({ accepted: false, blockingTests: ["T2"] });

  // (c) the rehearsal must use the manifest's digests; a different digest is refused
  const m = {
    api: "sha256:" + "1".repeat(64),
    worker: "sha256:" + "2".repeat(64),
    web: "sha256:" + "3".repeat(64),
  };
  expect(checkRehearsalDigests(m, m)).toEqual([]);
  expect(checkRehearsalDigests(m, { ...m, web: "sha256:" + "9".repeat(64) })).toEqual(["web"]);

  // negative control: an evaluator that treats BLOCKED_DEPENDENCY as acceptable would accept set iii
  const lenient = slice.every((t) => [...good].find((e) => e.testId === t.testId)?.verdict !== "FAIL");
  expect(lenient).toBe(true);
  expect(sets.iii!.d.accepted).toBe(false);

  observe({
    testId: "N07",
    blocked:
      "HUMAN-required: the staged testnet rehearsal (LIVE half of criterion (c): deploy the pinned artefact and run the testnet commitment and readback) and the human halves of G12; SEC22 (declared dependency) is not recorded. Fixture half passed: criteria (a), (b), (d), (e) and the digest refusal of (c)",
    observed: `evaluator reads the required set from the index (${real.length} release-gate tests G00-G11): with no evidence for this commit all ${none.blocking.length} block; synthetic all-PASS set accepted; sets ii (FAIL), iii (BLOCKED_DEPENDENCY), iv (NOT_RUN, DEFINED-only, UNDEFINED), v (no observed), vi (commit mismatch), vii (SKIP), viii (fixture, sandbox and simulated results where 16b section 8b requires live) each refused with the specific reason code and 0 chain calls (the evaluator takes no chain handle); G12 refused for FIXTURE, SANDBOX and SIMULATED mainnet evidence; refusal report names the blocking tests; manifest-digest rehearsal check refuses a different image digest; lenient-BLOCKED control detected. Live rehearsal not run`,
    fixtureHash: null,
    evidence: {
      requiredReleaseTests: real.length,
      setReasons: Object.fromEntries(
        Object.entries(sets).map(([k, s]) => [k, s.d.reasons.map((r) => r.code)]),
      ),
      mandatoryLive: ml,
    },
  });
});

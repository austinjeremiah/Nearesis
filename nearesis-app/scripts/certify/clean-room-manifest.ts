/**
 * Step 20 of final directive s27: an exact PASS/FAIL/BLOCKED manifest for a clean-room run. Called by clean-room.sh from the
 * clone, after the suite has recorded evidence into a temp reports directory:
 *
 *   tsx scripts/certify/clean-room-manifest.ts --stages <jsonl> --evidence <dir> --out <dir> --stamp <id> --head <sha> ...
 *
 * Per canonical test: PASS only when conformance certifies it from evidence recorded at this very HEAD; a recorded FAIL is
 * FAIL; BLOCKED_DEPENDENCY or a live test with no live evidence is BLOCKED; no evidence is NOT_RUN. Steps 8-19 of s27 are
 * never run by the script and are listed with the reason, so the manifest cannot read as a full certification.
 * Exit code 0 only when every stage passed and every required test is PASS (a --setup-only run: every setup stage passed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { evaluate } from "../conformance.ts";

const { values: a } = parseArgs({
  options: {
    stages: { type: "string" },
    evidence: { type: "string" },
    out: { type: "string" },
    stamp: { type: "string" },
    head: { type: "string" },
    "source-dirty": { type: "string", default: "0" },
    "setup-only": { type: "string", default: "0" },
    live: { type: "string", default: "0" },
    gate: { type: "string", default: "" },
    "toolchain-seeded": { type: "string", default: "0" },
    work: { type: "string", default: "" },
  },
});

interface Stage {
  stage: string;
  status: string;
  seconds: number;
  exitCode: number | null;
  description: string;
  note?: string;
}
const stages: Stage[] = readFileSync(a.stages!, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Stage);
const st = (n: string) => stages.find((s) => s.stage === n)?.status ?? "NOT_RUN";
const setupOnly = a["setup-only"] === "1";

const report = evaluate(a.evidence);
type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN" | "EXEMPT";
const verdictOf = (t: (typeof report.tests)[number]): Verdict => {
  if (t.state === "EXEMPT") return "EXEMPT";
  if (t.state === "CERTIFIED") return "PASS";
  if (t.state === "NOT_PASS")
    return t.lastVerdict === "BLOCKED_DEPENDENCY"
      ? "BLOCKED"
      : t.lastVerdict === "NOT_RUN"
        ? "NOT_RUN"
        : "FAIL";
  if (t.state === "LIVE_MISSING" || t.state === "DEPENDENCY_NOT_CERTIFIED") return "BLOCKED";
  if (t.state === "NO_EVIDENCE") return "NOT_RUN";
  return "FAIL";
};
const gateSel = a.gate || null;
const tests = report.tests
  .filter((t) => (t.required || t.state === "EXEMPT") && (!gateSel || t.gate === gateSel))
  .map((t) => ({
    testId: t.testId,
    gate: t.gate,
    verdict: verdictOf(t),
    state: t.state,
    lastRecordedVerdict: t.lastVerdict,
    evidencePath: t.evidencePath,
    commit: t.evidenceCommit,
    detail: t.detail,
  }));
const count = (v: Verdict) => tests.filter((t) => t.verdict === v).length;
const requiredTotal = tests.filter((t) => t.verdict !== "EXEMPT").length;

const sourceDirty = a["source-dirty"] === "1";
const stagesOk = stages.every((s) => s.status === "PASS" || (s.stage === "suite" && setupOnly));
const allPass = requiredTotal > 0 && count("PASS") === requiredTotal;
let verdict: "CERTIFIED" | "FAIL" | "BLOCKED" | "SETUP_OK" | "INCOMPLETE";
if (!stagesOk) verdict = stages.some((s) => s.status === "FAIL") ? "FAIL" : "BLOCKED";
else if (setupOnly) verdict = "SETUP_OK";
else if (count("FAIL")) verdict = "FAIL";
else if (!allPass) verdict = "BLOCKED";
else verdict = sourceDirty || gateSel || a.live !== "1" ? "INCOMPLETE" : "CERTIFIED";

const s27 = [
  [
    "1",
    "Secure the repository and make a clean checkout",
    st("clone") === "PASS" && st("prohibited") === "PASS" ? "PASS" : "FAIL",
    "clone stage and prohibited-path check",
  ],
  ["2", "Verify environment and service prerequisites", st("prerequisites"), "tools, docker, free ports"],
  [
    "3",
    "Rebuild from documented dependencies",
    ["toolchain", "install-js", "install-py", "build"].every((n) => st(n) === "PASS") ? "PASS" : "FAIL",
    "frozen lockfile install, typecheck, builds, wasm",
  ],
  ["4", "Apply migrations from a known baseline", st("migrate"), "empty disposable databases"],
  [
    "5",
    "Restore or regenerate permitted test datasets",
    "NOT_RUN",
    "fixtures are committed and loaded by the suite; no archive restore is performed here",
  ],
  ["6", "Start independent services", st("services"), "disposable compose project, host ports 65xxx"],
  [
    "7",
    "Run the entire canonical suite",
    setupOnly
      ? "NOT_RUN"
      : gateSel
        ? "NOT_RUN"
        : st("suite") === "PASS"
          ? allPass
            ? "PASS"
            : count("FAIL")
              ? "FAIL"
              : "BLOCKED"
          : st("suite"),
    `${count("PASS")}/${requiredTotal} required tests PASS`,
  ],
  ["8", "Run all approved additional tests", "NOT_RUN", "not part of this script"],
  [
    "9",
    "Run live external integration tests where authorized",
    a.live === "1" ? "NOT_RUN" : "BLOCKED",
    a.live === "1"
      ? "see per-test verdicts for live tests"
      : "run without --live: live tests need credentials and owner authorization",
  ],
  [
    "10",
    "Controlled fault injection",
    "NOT_RUN",
    "PERF11 and chaos run only inside the suite; no extra injection here",
  ],
  [
    "11",
    "1M/10M-row analytical benchmarks",
    "NOT_RUN",
    "PERF10 inside the suite; judged numbers need the quiet reference machine",
  ],
  ["12", "Permission and tenant isolation", "NOT_RUN", "covered only by the SEC/K tests inside the suite"],
  [
    "13",
    "50-question expert evaluation suite",
    "BLOCKED",
    "the corpus is not delivered (inventory REQ-FMP19-01)",
  ],
  [
    "14",
    "Complete live investigation",
    "BLOCKED",
    "needs account, entity and Intents analytics plus live inputs (inventory REQ-FMP20-01)",
  ],
  ["15", "Generate and reproduce a research capsule", "NOT_RUN", "V01/V12/B14 inside the suite"],
  ["16", "Verify OutLayer attestation", "BLOCKED", "live attestation needs credentials and the testnet path"],
  [
    "17",
    "Verify NEAR testnet commitment and readback",
    "BLOCKED",
    "live; needs the commitment target and approval records",
  ],
  ["18", "Verify cost and telemetry records", "NOT_RUN", "PERF12 inside the suite"],
  [
    "19",
    "Browser-dependent acceptance with the frontend developer",
    "BLOCKED",
    "needs the frontend developer",
  ],
  ["20", "Produce this manifest", "PASS", "written by clean-room-manifest.ts"],
].map(([step, name, status, note]) => ({ step: Number(step), name, status, note }));

const manifest = {
  version: 1,
  verdict,
  head: a.head,
  stamp: a.stamp,
  generatedAt: new Date().toISOString(),
  sourceTreeDirty: sourceDirty,
  scope: {
    gate: gateSel,
    setupOnly,
    live: a.live === "1",
    toolchainSeededFromCache: a["toolchain-seeded"] === "1",
  },
  note: "CERTIFIED needs: clean source tree, every stage PASS, every required canonical test PASS from evidence at this HEAD, a full (non-gate, non-setup-only) run with --live. Steps 8-19 of s27 are not run by this script.",
  stages,
  summary: {
    requiredTests: requiredTotal,
    PASS: count("PASS"),
    FAIL: count("FAIL"),
    BLOCKED: count("BLOCKED"),
    NOT_RUN: count("NOT_RUN"),
    registry: report.summary.registry,
    conformanceCertified: report.certified,
    treeClean: report.summary.treeClean,
    inventory: report.summary.inventory,
  },
  s27Steps: s27,
  tests,
};
const base = join(a.out!, `CLEAN-ROOM-${a.stamp}`);
writeFileSync(`${base}.json`, JSON.stringify(manifest, null, 2) + "\n");
const md = [
  `# Clean-room certification ${a.stamp}`,
  ``,
  `HEAD ${a.head} · verdict **${verdict}** · ${requiredTotal} required tests: PASS ${count("PASS")}, FAIL ${count("FAIL")}, BLOCKED ${count("BLOCKED")}, NOT_RUN ${count("NOT_RUN")}`,
  ``,
  `Registry: ${report.summary.registry.canonicalBaseline} canonical baseline, ${report.summary.registry.indexed} indexed, ${report.summary.registry.required} required.`,
  ``,
  `| Stage | Status | Seconds |`,
  `| --- | --- | --- |`,
  ...stages.map((s) => `| ${s.stage} | ${s.status} | ${s.seconds} |`),
  ``,
  `| s27 step | Status | Note |`,
  `| --- | --- | --- |`,
  ...s27.map((s) => `| ${s.step} ${s.name} | ${s.status} | ${s.note} |`),
  ``,
  `## Tests not PASS`,
  ``,
  ...tests
    .filter((t) => t.verdict !== "PASS" && t.verdict !== "EXEMPT")
    .map((t) => `- ${t.testId} (${t.gate}) ${t.verdict}: ${t.detail.slice(0, 160)}`),
  ``,
].join("\n");
writeFileSync(`${base}.md`, md);
console.log(md.split("\n").slice(0, 3).join("\n"));
console.log(`manifest: ${base}.json`);
process.exit(verdict === "CERTIFIED" || verdict === "SETUP_OK" ? 0 : 1);

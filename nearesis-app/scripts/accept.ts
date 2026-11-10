/**
 * Acceptance runner: `pnpm accept --id K01 [--live]` | `pnpm accept --gate G01` | `pnpm accept --all`
 * Runs each test's bound files (tests/TEST_INDEX.json `testFiles`, paths relative to nearesis-app/) with vitest,
 * collects the observation written via @nearesis/acceptance, and records a ch.16 TestResult under
 * NEARESIS_Build_Bible/reports/TESTS/<id>/<runId>.json. Verdicts:
 *   PASS               exit 0 AND an observation exists AND it is not blocked
 *   BLOCKED_DEPENDENCY observation.blocked set (e.g. missing credential) — never PASS
 *   FAIL               non-zero exit, or exit 0 without an observation (assertions must be observed, not assumed)
 *   NOT_RUN            no bound test files yet (not recorded as evidence; reported only)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TestResult } from "@nearesis/contracts";
import { APP_ROOT, REPO_ROOT, REPORTS, appendEvent, writeJsonAtomic } from "./coord-lib.ts";

interface IndexEntry {
  testId: string;
  gate: string;
  phase: string;
  passCondition: string;
  owner: string;
  testFiles: string[];
  live: boolean;
}
const { values: a } = parseArgs({
  options: {
    id: { type: "string" },
    gate: { type: "string" },
    all: { type: "boolean" },
    live: { type: "boolean" },
    session: { type: "string" },
  },
});
const index = JSON.parse(readFileSync(join(APP_ROOT, "tests", "TEST_INDEX.json"), "utf8")) as {
  tests: IndexEntry[];
};
const selected = index.tests.filter((t) => (a.all ? true : a.gate ? t.gate === a.gate : t.testId === a.id));
if (!selected.length) {
  console.error("no matching tests");
  process.exit(2);
}

const git = (...args: string[]) =>
  spawnSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).stdout.trim();
const commitSha = git("rev-parse", "HEAD");
const runtimeVersions = {
  node: process.version,
  pnpm: spawnSync("pnpm", ["-v"], { encoding: "utf8" }).stdout.trim(),
  platform: `${process.platform}-${process.arch}`,
};
const session = a.session ?? process.env.NEARESIS_SESSION ?? "unknown-session";
const engineOf = (t: IndexEntry) =>
  (t.owner === "ENGINE_B" ? "ENGINE_B" : "ENGINE_A") as "ENGINE_A" | "ENGINE_B";
let failures = 0;

for (const t of selected) {
  if (!t.testFiles.length) {
    console.log(`${t.testId}\tNOT_RUN\t(no bound test files)`);
    continue;
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${commitSha.slice(0, 8)}`;
  const out = mkdtempSync(join(tmpdir(), `accept-${t.testId}-`));
  const command = `vitest run ${t.testFiles.join(" ")}`;
  appendEvent({
    ts: new Date().toISOString(),
    session,
    engine: engineOf(t),
    kind: "test.started",
    subject: t.testId,
  });
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...t.testFiles], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NEARESIS_ACCEPT_OUT: out,
      NEARESIS_ACCEPT_LIVE: a.live ? "1" : "",
      FORCE_COLOR: "0",
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const obsPath = join(out, `${t.testId}.observation.json`);
  const obs = existsSync(obsPath)
    ? (JSON.parse(readFileSync(obsPath, "utf8")) as {
        observed: string;
        fixtureHash?: string | null;
        evidence?: unknown;
        blocked?: string;
      })
    : null;
  const logPath = join(REPORTS, "TESTS", t.testId, `${runId}.log`);
  let verdict: "PASS" | "FAIL" | "BLOCKED_DEPENDENCY";
  let failureReason: string | null = null;
  if (obs?.blocked) {
    verdict = "BLOCKED_DEPENDENCY";
    failureReason = obs.blocked;
  } else if (r.status === 0 && obs) verdict = "PASS";
  else {
    verdict = "FAIL";
    failureReason = r.status !== 0 ? `vitest exit ${r.status}` : "no observation recorded";
  }
  // Evidence must reference an exact commit: the test's own package(s) and the shared contracts must be clean.
  const pkgDirs = [
    ...new Set(t.testFiles.map((f) => f.split("/").slice(0, 2).join("/"))),
    "packages/contracts",
  ].map((d) => `nearesis-app/${d}`);
  const dirty = git("status", "--porcelain", "--", ...pkgDirs);
  if (verdict === "PASS" && dirty) {
    verdict = "FAIL";
    failureReason = `uncommitted changes in ${pkgDirs.join(", ")}; commit before recording evidence`;
  }
  const result = TestResult.parse({
    testId: t.testId,
    phase: t.phase,
    runId,
    executedAt: new Date().toISOString(),
    command: `pnpm accept --id ${t.testId}${a.live ? " --live" : ""} (${command})`,
    fixtureHash: obs?.fixtureHash ?? null,
    commitSha,
    runtimeVersions,
    environment: `${a.live ? "live" : "fixture"} local; ${runtimeVersions.platform}`,
    expected: t.passCondition,
    observed: obs?.observed ?? `no observation; vitest exit ${r.status}`,
    verdict,
    evidenceRefs: [
      `reports/TESTS/${t.testId}/${runId}.log.json`,
      ...(obs?.evidence ? [`reports/TESTS/${t.testId}/${runId}.evidence.json`] : []),
    ],
    failureReason,
  });
  writeJsonAtomic(join(REPORTS, "TESTS", t.testId, `${runId}.json`), result);
  writeJsonAtomic(logPath.replace(/\.log$/, ".log.json"), {
    stdout: r.stdout.slice(-200_000),
    stderr: r.stderr.slice(-50_000),
  });
  if (obs?.evidence)
    writeJsonAtomic(join(REPORTS, "TESTS", t.testId, `${runId}.evidence.json`), obs.evidence);
  appendEvent({
    ts: new Date().toISOString(),
    session,
    engine: engineOf(t),
    kind: verdict === "PASS" ? "test.passed" : verdict === "FAIL" ? "test.failed" : "test.blocked",
    subject: t.testId,
    detail: failureReason ?? undefined,
  });
  console.log(`${t.testId}\t${verdict}\t${failureReason ?? ""}`);
  if (verdict === "FAIL") failures++;
}
process.exit(failures ? 1 : 0);

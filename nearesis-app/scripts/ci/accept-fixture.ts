/**
 * CI fixture-mode acceptance: `pnpm ci:accept-fixture [--only K01,K02] [--strict-not-run]`.
 * Runs `pnpm accept --id <ID>` (scripts/accept.ts) for every REQUIRED, NON-LIVE test in tests/TEST_INDEX.json and
 * exits 1 on any FAIL. Live tests are skipped with an explicit log line and never recorded as PASS.
 *
 * Verdict handling:
 *   PASS                 counted
 *   FAIL                 fails the job
 *   BLOCKED_DEPENDENCY   an honest "could not decide" (unfinished integration, reference hardware): listed as a warning, never
 *                        counted as PASS; fails the job only with --strict-blocked
 *   NOT_RUN              no bound test file yet: reported loudly; fails the job only with --strict-not-run
 * Evidence goes wherever NEARESIS_REPORTS_DIR points (steps.sh sets a temp dir so CI never writes into the repo);
 * a machine-readable summary is written next to it as ci-accept-fixture.json.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface IndexEntry {
  testId: string;
  required: boolean;
  live: boolean;
  testFiles: string[];
}
type Verdict = "PASS" | "FAIL" | "BLOCKED_DEPENDENCY" | "NOT_RUN" | "SKIPPED_LIVE";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values: a } = parseArgs({
  options: {
    only: { type: "string" },
    "strict-not-run": { type: "boolean" },
    "strict-blocked": { type: "boolean" },
  },
});
const only = a.only ? new Set(a.only.split(",")) : null;
const index = JSON.parse(readFileSync(join(APP_ROOT, "tests", "TEST_INDEX.json"), "utf8")) as {
  tests: IndexEntry[];
};
const reportsDir = process.env.NEARESIS_REPORTS_DIR;
if (!reportsDir) {
  console.error("NEARESIS_REPORTS_DIR must be set so CI evidence is not written into the repository");
  process.exit(2);
}

const rows: { testId: string; verdict: Verdict; detail: string; seconds: number }[] = [];
for (const t of index.tests.filter((x) => x.required && (!only || only.has(x.testId)))) {
  if (t.live) {
    console.log(`${t.testId}\tlive: skipped in CI`);
    rows.push({ testId: t.testId, verdict: "SKIPPED_LIVE", detail: "live: skipped in CI", seconds: 0 });
    continue;
  }
  if (!t.testFiles.length) {
    console.log(`${t.testId}\tNOT_RUN (no bound test files)`);
    rows.push({ testId: t.testId, verdict: "NOT_RUN", detail: "no bound test files", seconds: 0 });
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync("pnpm", ["accept", "--id", t.testId, "--session", "ci"], {
    cwd: APP_ROOT,
    encoding: "utf8",
    env: { ...process.env, NEARESIS_ACCEPT_LIVE: "" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const line = r.stdout.split("\n").find((l) => l.startsWith(`${t.testId}\t`)) ?? "";
  const [, v = "", detail = ""] = line.split("\t");
  const verdict: Verdict =
    (["PASS", "FAIL", "BLOCKED_DEPENDENCY", "NOT_RUN"] as const).find((x) => x === v) ?? "FAIL";
  const note =
    verdict === "FAIL" && !line ? `no verdict line; exit ${r.status}; ${r.stderr.slice(-400)}` : detail;
  console.log(`${t.testId}\t${verdict}\t${seconds}s\t${note}`);
  rows.push({ testId: t.testId, verdict, detail: note, seconds });
}

const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
const summary = {
  executedAt: new Date().toISOString(),
  pass: count("PASS"),
  fail: count("FAIL"),
  blocked: count("BLOCKED_DEPENDENCY"),
  notRun: count("NOT_RUN"),
  skippedLive: count("SKIPPED_LIVE"),
  rows,
};
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, "ci-accept-fixture.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  `fixture acceptance: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.blocked} BLOCKED, ` +
    `${summary.notRun} NOT_RUN, ${summary.skippedLive} live skipped`,
);
for (const r of rows.filter((x) => x.verdict === "BLOCKED_DEPENDENCY"))
  console.log(`::warning::${r.testId} blocked: ${r.detail.slice(0, 160)}`);
for (const r of rows.filter((x) => x.verdict === "NOT_RUN"))
  console.log(`::warning::${r.testId} not implemented yet`);
const bad =
  summary.fail + (a["strict-blocked"] ? summary.blocked : 0) + (a["strict-not-run"] ? summary.notRun : 0);
process.exit(bad ? 1 : 0);

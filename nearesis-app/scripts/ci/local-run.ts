/**
 * Local replay of the CI workflow on a FRESH clone of HEAD: `pnpm ci:local [options]`.
 *
 *   --reuse <dir>   reuse an earlier work dir (keeps its clone, .toolchain and node_modules) instead of cloning anew
 *   --from <step>   start at <step> (earlier steps are recorded as "skipped")
 *   --only a,b      run just these steps
 *   --keep          leave the nearesis-ci stack and runner container up afterwards
 *   --bail          stop at the first failing step (default: setup failures stop the run, check failures do not)
 *
 * Isolation: the compose project is `nearesis-ci` with different host ports (scripts/ci/compose.local.yml), so the
 * developers' `nearesis` stack is never touched; teardown refuses any other project name. The checks run inside an
 * ubuntu:24.04 container (the closest local stand-in for the ubuntu-24.04 runner) attached to the project network,
 * with socat forwarding the stack's default loopback ports (55432, 56379, 58123, 59000, 57233, 4000) to the compose
 * services, because several package test helpers hard-code those ports. Steps are read from scripts/ci/steps.sh, the
 * file the workflow calls, and the workflow is checked to list exactly the same steps in the same order.
 * Timings and verdicts go to NEARESIS_Build_Bible/reports/TESTS/CI-LOCAL/<timestamp>.json.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const APP_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const REPORTS = process.env.NEARESIS_REPORTS_DIR ?? join(REPO_ROOT, "NEARESIS_Build_Bible", "reports");
const PROJECT = "nearesis-ci";
const CONTAINER = "nearesis-ci-runner";
const NETWORK = `${PROJECT}_default`;
if (PROJECT === "nearesis") throw new Error("refusing to operate on the default compose project");

const { values: a } = parseArgs({
  options: {
    reuse: { type: "string" },
    from: { type: "string" },
    only: { type: "string" },
    keep: { type: "boolean" },
    bail: { type: "boolean" },
  },
});

const run = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; log?: string } = {},
) => {
  const fd = opts.log ? openSync(opts.log, "a") : null;
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: fd === null ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const work = a.reuse
  ? resolve(a.reuse)
  : mkdtempSync(join(process.env.NEARESIS_CI_WORKDIR ?? tmpdir(), "nearesis-ci-"));
const clone = join(work, "repo");
const logs = join(work, "logs");
mkdirSync(logs, { recursive: true });
console.log(`work dir: ${work}`);

if (!a.reuse) {
  const c = run("git", ["clone", "--no-hardlinks", "--quiet", REPO_ROOT, clone]);
  if (c.status) throw new Error(`clone failed: ${c.out}`);
}
const head = run("git", ["-C", clone, "rev-parse", "HEAD"]).out.trim();
const steps = run("sh", [join(clone, "nearesis-app/scripts/ci/steps.sh"), "list"])
  .out.trim()
  .split("\n");

// The workflow must call exactly these steps, in this order.
const wf = readFileSync(join(clone, ".github/workflows/ci.yml"), "utf8");
const wfSteps = [...wf.matchAll(/steps\.sh ([a-z0-9-]+)/g)].map((m) => m[1]);
if (wfSteps.join() !== steps.join()) {
  throw new Error(`workflow steps [${wfSteps}] differ from steps.sh [${steps}]`);
}

const HOST_STEPS = new Set(["services-up", "db-roles"]);
const SETUP_STEPS = new Set([
  "toolchain",
  "install-js",
  "install-py",
  "playwright",
  "services-up",
  "db-roles",
]);
const composeEnv = {
  NEARESIS_COMPOSE_PROJECT: PROJECT,
  NEARESIS_COMPOSE_EXTRA: join(clone, "nearesis-app/scripts/ci/compose.local.yml"),
};
const FORWARD: [number, string][] = [
  [55432, "postgres:5432"],
  [56379, "redis:6379"],
  [58123, "clickhouse:8123"],
  [59000, "clickhouse:9000"],
  [57233, "temporal:7233"],
  [58233, "temporal:8233"],
  [4000, "cube:4000"],
];
const dx = (script: string, log?: string) =>
  run("docker", ["exec", "-w", "/work/repo/nearesis-app", CONTAINER, "bash", "-lc", script], { log });

function startRunner(): void {
  run("docker", ["rm", "-f", CONTAINER]);
  const r = run("docker", [
    "run",
    "-d",
    "--name",
    CONTAINER,
    "-v",
    `${work}:/work`,
    "-v",
    "nearesis-ci-cache:/root/.cache",
    "-v",
    "nearesis-ci-pnpm:/root/.local/share/pnpm",
    "-e",
    "CI=true",
    "-e",
    "NEARESIS_CI_REPORTS_DIR=/work/ci-reports",
    "ubuntu:24.04",
    "sleep",
    "infinity",
  ]);
  if (r.status) throw new Error(`runner container failed: ${r.out}`);
  // Stand-in for the GitHub runner image's preinstalled tools.
  const p = dx(
    "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq curl xz-utils ca-certificates git socat sudo >/dev/null && git config --global --add safe.directory '*'",
    join(logs, "runner-prep.log"),
  );
  if (p.status) throw new Error("runner prep failed, see logs/runner-prep.log");
}
function attachRunner(): void {
  run("docker", ["network", "connect", NETWORK, CONTAINER]);
  for (const [port, target] of FORWARD) {
    dx(`nohup socat TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr TCP:${target} >/dev/null 2>&1 &`);
  }
}

const only = a.only ? new Set(a.only.split(",")) : null;
const results: { step: string; where: string; status: string; seconds: number; exitCode: number | null }[] =
  [];
let started = !a.from;
let setupFailed = false;
const hostEnv = { ...composeEnv };
if (!a.reuse || !a.from) startRunner();
else if (run("docker", ["inspect", CONTAINER]).status) startRunner();

for (const step of steps) {
  if (a.from === step) started = true;
  if (!started || (only && !only.has(step))) {
    results.push({ step, where: "-", status: "skipped", seconds: 0, exitCode: null });
    continue;
  }
  if (setupFailed && SETUP_STEPS.has(step)) {
    results.push({ step, where: "-", status: "skipped", seconds: 0, exitCode: null });
    continue;
  }
  const log = join(logs, `${step}.log`);
  const t0 = Date.now();
  console.log(`> ${step}`);
  const where = HOST_STEPS.has(step) ? "host" : "container";
  const r =
    where === "host"
      ? run("sh", [join(clone, "nearesis-app/scripts/ci/steps.sh"), step], {
          cwd: join(clone, "nearesis-app"),
          env: hostEnv,
          log,
        })
      : dx(`sh scripts/ci/steps.sh ${step}`, log);
  if (step === "services-up" && r.status === 0) attachRunner();
  const seconds = Math.round((Date.now() - t0) / 1000);
  const status = r.status === 0 ? "pass" : "fail";
  results.push({ step, where, status, seconds, exitCode: r.status });
  console.log(`  ${status} (${seconds}s)`);
  if (r.status) {
    const tail = readFileSync(log, "utf8").split("\n").slice(-25).join("\n");
    console.log(tail);
    if (SETUP_STEPS.has(step)) setupFailed = true;
    if (a.bail) break;
  }
}

// Fixture evidence artifact (what the workflow uploads) is copied out of the throwaway work dir.
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(REPORTS, "TESTS", "CI-LOCAL");
mkdirSync(outDir, { recursive: true });
const summary = {
  executedAt: new Date().toISOString(),
  commit: head,
  workDir: work,
  composeProject: PROJECT,
  hostPorts: "postgres 65432, redis 66379, clickhouse 68123/69000, temporal 67233/68233, cube 64000",
  runner: "ubuntu:24.04 container (aarch64) + socat loopback forwarders",
  allPassed: results.every((r) => r.status !== "fail"),
  steps: results,
};
writeFileSync(join(outDir, `${ts}.json`), JSON.stringify(summary, null, 2) + "\n");
console.log(`report: ${join(outDir, `${ts}.json`)}`);

if (!a.keep) {
  run("docker", [
    "compose",
    "-p",
    PROJECT,
    "-f",
    join(clone, "nearesis-app/infrastructure/compose/docker-compose.yml"),
    "-f",
    join(clone, "nearesis-app/infrastructure/compose/analytics.yml"),
    "down",
    "-v",
    "--remove-orphans",
  ]);
  run("docker", ["rm", "-f", CONTAINER]);
}
for (const r of results)
  console.log(`${r.status.padEnd(8)}${r.step.padEnd(16)}${r.where.padEnd(10)}${r.seconds}s`);
process.exit(summary.allPassed ? 0 : 1);

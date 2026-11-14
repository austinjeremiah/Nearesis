import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "ops",
  "supervise.sh",
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f() && Date.now() < end) await sleep(100);
  expect(f()).toBe(true);
}
const env = (dir: string, cmd: string) => ({
  ...process.env,
  NEARESIS_SUPERVISE_DIR: join(dir, "run"),
  NEARESIS_LOG_DIR: join(dir, "logs"),
  NEARESIS_SUPERVISE_CMD: cmd,
  NEARESIS_BACKOFF_MIN: "1",
  NEARESIS_BACKOFF_MAX: "2",
});
const log = (dir: string) =>
  existsSync(join(dir, "logs", "scheduler.log"))
    ? readFileSync(join(dir, "logs", "scheduler.log"), "utf8")
    : "";

describe("supervise.sh", () => {
  it("restarts a crashing child, refuses a second instance, and forwards SIGTERM so the child can release its lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    const marker = join(dir, "term-seen");
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    // crashes (exit 1) on the first two runs, then runs until SIGTERM and records that it was told to release
    const child = join(dir, "child.sh");
    writeFileSync(
      child,
      `#!/bin/sh
n=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"
[ $n -lt 3 ] && exit 1
trap 'echo released > "${marker}"; exit 0' TERM
while :; do sleep 0.2; done
`,
      { mode: 0o755 },
    );
    const sup = spawn("bash", [SCRIPT, "start", "scheduler"], { env: env(dir, child), stdio: "ignore" });
    await until(() => log(dir).includes("starting scheduler (attempt 3)"));
    expect(log(dir)).toContain("exited with code 1");
    const second = spawnSync("bash", [SCRIPT, "start", "scheduler"], {
      env: env(dir, child),
      encoding: "utf8",
    });
    expect(second.status).toBe(3);
    expect(second.stderr).toContain("already running");
    const st = spawnSync("bash", [SCRIPT, "status", "scheduler"], { env: env(dir, child), encoding: "utf8" });
    expect(st.stdout).toContain("supervised");
    spawnSync("bash", [SCRIPT, "stop", "scheduler"], { env: env(dir, child) });
    await until(() => existsSync(marker));
    await until(() => sup.exitCode !== null);
    expect(existsSync(join(dir, "run", "scheduler.pid"))).toBe(false);
  }, 40_000);

  it("does not restart a backfill that exits 0 (finished)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    const sup = spawn("bash", [SCRIPT, "start", "backfill"], { env: env(dir, "true"), stdio: "ignore" });
    await until(() => sup.exitCode !== null);
    const l = readFileSync(join(dir, "logs", "backfill.log"), "utf8");
    expect(l).toContain("backfill finished (exit 0); not restarting");
    expect((l.match(/starting backfill/g) ?? []).length).toBe(1);
  }, 20_000);

  it("rotates an oversized log (copy-truncate, gzip, bounded history)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    const child = join(dir, "child.sh");
    writeFileSync(child, "#!/bin/sh\nhead -c 3000 /dev/zero | tr '\\0' x; echo; exit 1\n", { mode: 0o755 });
    const sup = spawn("bash", [SCRIPT, "start", "scheduler"], {
      env: { ...env(dir, child), NEARESIS_LOG_MAX_BYTES: "1000" },
      stdio: "ignore",
    });
    await until(() => existsSync(join(dir, "logs", "scheduler.log.1.gz")));
    spawnSync("bash", [SCRIPT, "stop", "scheduler"], { env: env(dir, child) });
    await until(() => sup.exitCode !== null);
  }, 30_000);
});

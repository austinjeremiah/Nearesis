/**
 * BOOT01: fresh clone at HEAD installs deterministically; typecheck and lint exit 0.
 * The clone gets a symlink to the real `.toolchain` (Node/pnpm/uv/Python) purely to avoid re-downloading runtimes;
 * all dependencies (node_modules, .venv) are installed fresh from the lockfiles.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { observe } from "@nearesis/acceptance";
import { afterAll, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const repoRoot = resolve(appRoot, "..");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
let tmp = "";

function run(cwd: string, cmd: string, args: string[]) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 1 << 28,
  });
  const tail = ((r.stdout ?? "") + (r.stderr ?? "")).split("\n").slice(-15).join("\n");
  return { cmd: `${cmd} ${args.join(" ")}`, status: r.status, ms: Date.now() - t0, tail };
}

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

it(
  "BOOT01: fresh install with lockfile is deterministic; typecheck and lint exit 0",
  { timeout: 1_200_000 },
  () => {
    tmp = mkdtempSync(join(tmpdir(), "boot01-"));
    const clone = run(tmp, "git", ["clone", "--no-hardlinks", "-q", repoRoot, join(tmp, "repo")]);
    expect(clone.status, clone.tail).toBe(0);
    const app = join(tmp, "repo", "nearesis-app");
    expect(existsSync(join(app, "node_modules"))).toBe(false);
    symlinkSync(join(appRoot, ".toolchain"), join(app, ".toolchain"));

    const pnpmLock = join(app, "pnpm-lock.yaml");
    const uvLock = join(app, "uv.lock");
    const before = { pnpm: sha(pnpmLock), uv: sha(uvLock) };

    const steps = [
      run(app, "pnpm", ["install", "--frozen-lockfile"]),
      run(app, "pnpm", ["typecheck"]),
      run(app, "pnpm", ["lint"]),
      run(app, "uv", ["sync", "--frozen"]),
    ];
    for (const s of steps) expect(s.status, `${s.cmd}\n${s.tail}`).toBe(0);

    const second = run(app, "pnpm", ["install", "--frozen-lockfile"]);
    expect(second.status, second.tail).toBe(0);
    const after = { pnpm: sha(pnpmLock), uv: sha(uvLock) };
    expect(after).toEqual(before);
    expect(run(app, "git", ["status", "--porcelain", "--", "pnpm-lock.yaml", "uv.lock"]).tail.trim()).toBe(
      "",
    );

    const head = run(repoRoot, "git", ["rev-parse", "HEAD"]).tail.trim();
    observe({
      testId: "BOOT01",
      observed: `fresh clone of HEAD ${head.slice(0, 12)}: ${[...steps, second].map((s) => `${s.cmd}=${s.status} (${Math.round(s.ms / 1000)}s)`).join("; ")}; lockfile hashes unchanged after second install`,
      fixtureHash: before.pnpm,
      evidence: {
        cloneHead: head,
        pnpmLockSha256: before.pnpm,
        uvLockSha256: before.uv,
        lockHashesAfterSecondInstall: after,
      },
    });
  },
);

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "..", "..", "scripts", "certify", "check-prohibited.sh");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function repoWith(files: string[]): string {
  const d = mkdtempSync(join(tmpdir(), "prohibited-"));
  dirs.push(d);
  const git = (...a: string[]) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q");
  for (const f of files) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), "x\n");
  }
  git("add", "-f", "-A");
  return d;
}
const check = (repo: string) =>
  spawnSync("sh", [SCRIPT], { encoding: "utf8", env: { ...process.env, NEARESIS_PROHIBITED_REPO: repo } });

describe("prohibited tracked paths (final directive s24)", () => {
  it("passes a repository with only allowed files, including .env.example", () => {
    const r = check(repoWith(["nearesis-app/src/a.ts", "nearesis-app/.env.example", "README.md"]));
    expect(r.status).toBe(0);
  });

  it.each([
    "NEARESIS_Build_Bible/chapters/00.md",
    "final_master_prompt.md",
    ".env",
    "nearesis-app/.env.local",
    "keys/signing.pem",
    "nearesis-app/.data/ledger.json",
  ])("fails when %s is tracked", (path) => {
    const r = check(repoWith(["ok.txt", path]));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(path);
  });

  it("is wired into the CI workflow and the step list, with the secret scan", () => {
    const steps = spawnSync("sh", [join(SCRIPT, "..", "..", "ci", "steps.sh"), "list"], {
      encoding: "utf8",
    }).stdout.split("\n");
    expect(steps[0]).toBe("prohibited");
    expect(steps).toContain("secret-scan");
  });
});

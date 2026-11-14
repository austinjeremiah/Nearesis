import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "..", "..", "scripts", "certify", "clean-room.sh");

describe("clean-room certification script", () => {
  it("is valid POSIX sh", () => {
    expect(spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" }).status).toBe(0);
  });
  it("documents its stages and refuses unknown options without side effects", () => {
    const h = spawnSync("sh", [SCRIPT, "--help"], { encoding: "utf8" });
    expect(h.status).toBe(0);
    for (const word of ["frozen-lockfile", "migrate", "disposable", "--setup-only", "PASS/FAIL/BLOCKED"])
      expect(h.stdout).toContain(word);
    const bad = spawnSync("sh", [SCRIPT, "--nope"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
  });
});

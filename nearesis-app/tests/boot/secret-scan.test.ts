import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditUrls } from "../../scripts/security/url-audit.ts";
import { parseEnv, scanRepo } from "../../scripts/security/secret-scan.ts";

// All canaries are synthetic and assembled at runtime so this file itself never matches a pattern.
const canaries = {
  jwt: ["eyJ" + "hbGciOiJIUzI1", "eyJ" + "zdWIiOiJ0ZXN0", "c2lnbmF0dXJl" + "c2lnbmF0dXJl"].join("."),
  ed: "ed25519" + ":" + "A".repeat(80),
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----",
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  sk: "sk" + "-" + "a1B2c3D4e5F6g7H8i9J0k1",
  google: "AIza" + "B".repeat(35),
};
const envValue = "synthetic-env-value-" + "12345678";

let dir = "";
const git = (...a: string[]) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
function repo(files: Record<string, string>, tracked = true) {
  dir = mkdtempSync(join(tmpdir(), "scan-test-"));
  git("init", "-q");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  if (tracked) git("add", "-A");
}
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("secret scanner", () => {
  it("detects every pattern and reports name/file/line only", () => {
    repo(Object.fromEntries(Object.entries(canaries).map(([k, v]) => [`${k}.txt`, `\nkey = ${v}\n`])));
    const f = scanRepo(dir);
    expect(f.map((x) => x.name).sort()).toEqual(
      [
        "aws-access-key-id",
        "ed25519-private-key",
        "google-api-key",
        "jwt",
        "pem-private-key",
        "sk-api-key",
      ].sort(),
    );
    expect(f.every((x) => x.line === 2)).toBe(true);
    expect(JSON.stringify(f)).not.toContain("AKIA");
  });
  it("detects .env values in tracked files but ignores untracked and short values", () => {
    repo(
      {
        ".env": `SECRET_A=${envValue}\nSHORT=abc\nexport Q="quoted-value-0000"\n`,
        "a.ts": `const x = "${envValue}";\n`,
      },
      false,
    );
    git("add", "a.ts");
    const f = scanRepo(dir);
    expect(f).toEqual([{ kind: "env-value", name: "SECRET_A", file: "a.ts", line: 1 }]);
    expect(parseEnv(`A=1234567\nB='12345678'`)).toEqual([{ name: "B", value: "12345678" }]);
  });
  it("does not scan untracked files and honours the allowlist", () => {
    repo({ "t.txt": canaries.aws }, false);
    expect(scanRepo(dir)).toEqual([]);
    git("add", "t.txt");
    expect(scanRepo(dir)).toHaveLength(1);
    expect(scanRepo(dir, [{ file: "t.txt", line: 1, reason: "synthetic" }])).toEqual([]);
  });
  it("passes a clean repo", () => {
    repo({ "ok.ts": "export const a = 1;\n" });
    expect(scanRepo(dir)).toEqual([]);
  });
});

describe("url auditor", () => {
  const entry = {
    id: "x",
    hosts: ["api.example.com"],
    officialDocUrl: "https://d",
    accessedAt: "2026-01-01",
    version: "1",
    auth: "-",
    rateLimits: "-",
    status: "TO_VERIFY" as const,
    notes: "-",
  };
  it("flags undocumented hosts, allows localhost and registered hosts, skips excluded paths", () => {
    repo({
      "a.ts":
        'fetch("https://api.example.com/x"); fetch("http://127.0.0.1:1"); fetch("https://evil.example.org/y");\n',
    });
    spawnSync("mkdir", ["-p", join(dir, "docs"), join(dir, "x", "test")]);
    writeFileSync(join(dir, "docs", "d.ts"), "https://skipped.example.net\n");
    writeFileSync(join(dir, "x", "test", "t.ts"), "https://skipped2.example.net\n");
    git("add", "-A");
    const r = auditUrls(dir, [entry]);
    expect(r.undocumented.map((u) => u.host)).toEqual(["evil.example.org"]);
  });
});

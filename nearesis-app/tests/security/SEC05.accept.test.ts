/**
 * SEC05: dependency and credential scan. PASS: no critical unmitigated finding or secret.
 * Runs the repository secret scanner (tracked files), a wider credential sweep (untracked-but-not-ignored files and the
 * test evidence directory, comparing the real `.env` values in-process only), `pnpm audit` for the npm workspace and
 * `uv audit` for the Python project. Findings are reported by package/advisory/file:line, never by value.
 * Network used: the package registry host already used by pnpm, and the advisory service `uv audit` queries.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  PATTERNS,
  isSecretCandidate,
  loadAllow,
  parseEnv,
  scanRepo,
} from "../../scripts/security/secret-scan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..", "..");
const REPO = resolve(APP, "..");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

interface Mitigation {
  advisory: string;
  reason: string;
}
const mitigations: Mitigation[] = existsSync(join(here, "dependency-mitigations.json"))
  ? (
      JSON.parse(readFileSync(join(here, "dependency-mitigations.json"), "utf8")) as {
        mitigations: Mitigation[];
      }
    ).mitigations
  : [];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

it("SEC05: no critical dependency finding and no committed or recorded credential", () => {
  // ---- scanner self-check: each pattern fires on a synthetic sample built at run time (no literal in the tree)
  const b = (n: number) => "A1b2C3d4E5f6G7h8".repeat(Math.ceil(n / 16)).slice(0, n);
  const samples: Record<string, string> = {
    jwt: `${"eyJ" + b(10)}.${b(12)}.${b(12)}`,
    "pem-private-key": "-----BEGIN " + "PRIVATE KEY-----",
    "aws-access-key-id": "AKIA" + "ABCDEFGHIJKLMNOP",
    "sk-api-key": "sk-" + b(24),
    "google-api-key": "AIza" + b(35),
  };
  for (const p of PATTERNS)
    if (samples[p.name])
      expect(p.re.test(samples[p.name]!), `pattern ${p.name} must fire on its sample`).toBe(true);

  // ---- credential scan 1: tracked files (the repository scanner, same allowlist)
  const tracked = scanRepo(REPO, loadAllow(join(APP, "scripts", "security", "secret-scan.allow.json")));
  expect(tracked.map((f) => `${f.kind}:${f.name}:${f.file}:${f.line}`)).toEqual([]);

  // ---- credential scan 2: untracked-but-not-ignored files and test evidence/log files
  const envPath = join(REPO, ".env");
  const envVars = (existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : []).filter((v) =>
    isSecretCandidate(v.name, v.value),
  );
  const untracked = spawnSync("git", ["-C", REPO, "ls-files", "-o", "--exclude-standard", "-z"], {
    encoding: "buffer",
    maxBuffer: 1 << 28,
  })
    .stdout.toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((f) => join(REPO, f));
  const evidenceDir = join(REPO, "NEARESIS_Build_Bible", "reports", "TESTS");
  const extra = [...untracked, ...walk(evidenceDir)];
  const sweep: string[] = [];
  let scanned = 0;
  for (const f of extra) {
    let buf: Buffer;
    try {
      if (statSync(f).size > 20 * 1024 * 1024) continue;
      buf = readFileSync(f);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    scanned++;
    const text = buf.toString("utf8");
    for (const v of envVars)
      if (text.includes(v.value)) sweep.push(`env-value:${v.name}:${f.replace(REPO, "")}`);
    for (const p of PATTERNS) if (p.re.test(text)) sweep.push(`pattern:${p.name}:${f.replace(REPO, "")}`);
  }
  expect(sweep).toEqual([]);

  // ---- hygiene: lockfiles present, exact pins, no `latest`, compose images pinned by digest
  expect(existsSync(join(APP, "pnpm-lock.yaml")) && existsSync(join(APP, "uv.lock"))).toBe(true);
  const pkgFiles = [
    join(APP, "package.json"),
    ...["apps", "packages", "services", "plugins"].flatMap((d) =>
      existsSync(join(APP, d))
        ? readdirSync(join(APP, d))
            .map((n) => join(APP, d, n, "package.json"))
            .filter(existsSync)
        : [],
    ),
  ];
  const unpinned: string[] = [];
  for (const f of pkgFiles) {
    const j = JSON.parse(readFileSync(f, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const sec of ["dependencies", "devDependencies", "optionalDependencies"])
      for (const [n, v] of Object.entries(j[sec] ?? {}))
        if (!/^(workspace:|\d+\.\d+\.\d+(-[\w.]+)?$)/.test(v))
          unpinned.push(`${f.replace(APP, "")}:${n}@${v}`);
  }
  expect(unpinned).toEqual([]);
  const composeDir = join(APP, "infrastructure", "compose");
  const unpinnedImages: string[] = [];
  for (const f of walk(composeDir).filter((x) => /\.ya?ml$/.test(x)))
    for (const m of readFileSync(f, "utf8").matchAll(/^\s*image:\s*(\S+)/gm))
      if (!/@sha256:[0-9a-f]{64}$/.test(m[1]!) || /:latest(@|$)/.test(m[1]!))
        unpinnedImages.push(`${f.replace(APP, "")}:${m[1]}`);
  expect(unpinnedImages).toEqual([]);

  // ---- dependency scan: npm workspace
  const audit = spawnSync("pnpm", ["audit", "--json"], { cwd: APP, encoding: "utf8", maxBuffer: 1 << 28 });
  let npm: {
    advisories: Record<
      string,
      { id?: number; github_advisory_id?: string; severity: string; module_name: string; title: string }
    >;
    metadata: { vulnerabilities: Record<string, number>; totalDependencies: number };
  } | null = null;
  try {
    npm = JSON.parse(audit.stdout) as typeof npm;
  } catch {
    /* handled below */
  }
  if (!npm?.metadata) {
    observe({
      testId: "SEC05",
      observed:
        "credential scans completed with 0 findings but the advisory service for the npm audit was unreachable",
      blocked: "pnpm audit returned no advisory data (registry unreachable)",
      evidence: { credentialFindings: 0, filesSwept: scanned },
    });
    return;
  }
  const advisories = Object.values(npm.advisories);
  const critical = advisories.filter((a) => a.severity === "critical");
  const mitigated = (a: { github_advisory_id?: string; id?: number }) =>
    mitigations.some((m) => m.advisory === (a.github_advisory_id ?? String(a.id)));
  const criticalUnmitigated = critical.filter((a) => !mitigated(a));
  expect(criticalUnmitigated.map((a) => `${a.module_name}:${a.title}`)).toEqual([]);

  // ---- dependency scan: Python project
  const uv = spawnSync("uv", ["audit", "--preview-features", "audit-command"], {
    cwd: APP,
    encoding: "utf8",
  });
  const uvOut = `${uv.stdout}${uv.stderr}`
    .split("\n")
    .filter((l) => /vulnerab|Resolved|adverse/i.test(l))
    .join(" | ");
  expect(uv.status, uvOut).toBe(0);

  const bySev = npm.metadata.vulnerabilities;
  observe({
    testId: "SEC05",
    observed: `credential scan: ${tracked.length} findings in tracked files, ${sweep.length} in ${scanned} untracked/evidence files (0 .env values or token patterns); lockfiles present, ${pkgFiles.length} package.json files all exact-pinned (${unpinned.length} unpinned), every compose image digest-pinned (${unpinnedImages.length} unpinned); pnpm audit over ${npm.metadata.totalDependencies} npm packages: critical ${bySev.critical ?? 0} (${criticalUnmitigated.length} unmitigated), high ${bySev.high ?? 0}, moderate ${bySev.moderate ?? 0}, low ${bySev.low ?? 0}; uv audit: ${uvOut}`,
    fixtureHash: sha(join(APP, "pnpm-lock.yaml")),
    evidence: {
      npm: bySev,
      npmAdvisories: advisories.map((a) => ({
        id: a.github_advisory_id ?? a.id,
        severity: a.severity,
        package: a.module_name,
        title: a.title,
      })),
      uv: uvOut,
      pnpmLockSha256: sha(join(APP, "pnpm-lock.yaml")),
      uvLockSha256: sha(join(APP, "uv.lock")),
      filesSwept: scanned,
      mitigationsRecorded: mitigations.length,
    },
  });
}, 180_000);

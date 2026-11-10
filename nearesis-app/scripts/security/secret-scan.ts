/**
 * Secret scanner (BOOT02). Scans git-tracked files only (`git ls-files -z` at the repo root) for
 *  (a) the exact values of every variable in the repo-root `.env` (when present), compared in-process only, and
 *  (b) well-known credential patterns.
 * Findings report variable name / pattern name, file and line. Matched values are NEVER printed.
 * Allowlist: scripts/security/secret-scan.allow.json  { "allow": [{ "file", "line", "reason" }] }.
 * Exit code 1 on any finding.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Finding {
  kind: "env-value" | "pattern";
  name: string;
  file: string;
  line: number;
}
export interface AllowEntry {
  file: string;
  line: number;
  reason: string;
}

/** Env values shorter than this are not credentials-shaped and would cause false positives (e.g. "testnet"). */
export const MIN_ENV_VALUE_LENGTH = 8;

export const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "ed25519-private-key", re: /ed25519:[1-9A-HJ-NP-Za-km-z]{64,}/ },
  { name: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "sk-api-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/ },
];

export function parseEnv(text: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (v.length >= MIN_ENV_VALUE_LENGTH) out.push({ name: m[1]!, value: v });
  }
  return out;
}

/** Variable names that denote credentials. Any value of such a variable is treated as secret. */
const SECRET_NAME = /(KEY|TOKEN|JWT|SECRET|PASSWORD|PASSWD|PRIVATE|SIGNING|CREDENTIAL|AUTH)/i;

function shannonEntropy(v: string): number {
  const counts = new Map<string, number>();
  for (const ch of v) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / v.length) * Math.log2(n / v.length);
  return h;
}

/**
 * A `.env` value is compared against tracked files when it is a credential: its variable name is credential-like, or
 * the value itself looks like key material (>= 20 chars, entropy >= 3.5 bits/char). Plain configuration such as
 * `INFERENCE_PROVIDER=openrouter` or a model id is not secret and would otherwise flag every doc that names it.
 */
export function isSecretCandidate(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || (value.length >= 20 && shannonEntropy(value) >= 3.5);
}

export function scanRepo(repoRoot: string, allow: AllowEntry[] = []): Finding[] {
  const ls = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 1 << 28 });
  if (ls.status !== 0) throw new Error("git ls-files failed");
  const files = ls.stdout.toString("utf8").split("\0").filter(Boolean);
  const envPath = join(repoRoot, ".env");
  const envVars = (existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : []).filter((v) =>
    isSecretCandidate(v.name, v.value),
  );
  const findings: Finding[] = [];
  for (const file of files) {
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) continue; // deleted in working tree
    const buf = readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString("utf8").split("\n");
    lines.forEach((text, i) => {
      const line = i + 1;
      if (allow.some((a) => a.file === file && a.line === line)) return;
      for (const v of envVars) {
        if (text.includes(v.value)) findings.push({ kind: "env-value", name: v.name, file, line });
      }
      for (const p of PATTERNS) {
        if (p.re.test(text)) findings.push({ kind: "pattern", name: p.name, file, line });
      }
    });
  }
  return findings;
}

export function loadAllow(path: string): AllowEntry[] {
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, "utf8")) as { allow?: AllowEntry[] };
  const allow = j.allow ?? [];
  for (const a of allow) {
    if (!a.file || !Number.isInteger(a.line) || !a.reason)
      throw new Error("allowlist entries need file, line, reason");
  }
  return allow;
}

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(here, "..", "..", "..");
  const findings = scanRepo(repoRoot, loadAllow(join(here, "secret-scan.allow.json")));
  if (findings.length) {
    for (const f of findings) console.error(`FINDING ${f.kind} ${f.name} ${f.file}:${f.line}`);
    console.error(`secret-scan: ${findings.length} finding(s)`);
    process.exit(1);
  }
  console.log("secret-scan: 0 findings");
}

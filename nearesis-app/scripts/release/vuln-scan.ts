/**
 * Vulnerability and secret scanning for the release (ch.12 "Vulnerability management", ch.17, SEC05/SEC11/N06) with the
 * pinned trivy binary. The policy is a pure function over normalised findings so it is tested without the scanner.
 *
 * Severity rule: ch.12/ch.17 give no numeric rule beyond SEC05 "no critical unmitigated finding or secret". Interpretation
 * (recorded for the owner): BLOCK on any CRITICAL vulnerability (SEC22: a critical is never waivable), BLOCK on any HIGH that
 * has a fixed version available, and BLOCK on any secret. A HIGH with no fix available BLOCKs unless it has a matching,
 * unexpired entry in the risk-acceptance register (scripts/release/vuln-acceptances.json: CVE, package, image/lockfile,
 * justification, human acceptor, independent reviewer, created and expiry date, at most 30 days). When a fix becomes
 * available the acceptance is void and the finding blocks as HIGH_WITH_FIX. A CRITICAL can never be accepted.
 * A HIGH with a fix is waivable only by a signed SEC22 waiver (human signer, independent reviewer, unexpired).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TRIVY_LOCK = JSON.parse(readFileSync(join(APP, "scripts/release/trivy.lock.json"), "utf8")) as {
  version: string;
  binarySha256: Record<string, string>;
};
export const WAIVER_FILE = join(APP, "scripts/release/vuln-waivers.json");
export const ACCEPTANCE_FILE = join(APP, "scripts/release/vuln-acceptances.json");
export const MAX_ACCEPTANCE_DAYS = 30;
export const TRIVY_CACHE = join(APP, ".toolchain", "trivy-cache");

export interface VulnFinding {
  kind: "vulnerability";
  id: string;
  pkg: string;
  installed: string;
  fixed: string | null;
  severity: string;
  status: string;
  target: string;
}
export interface SecretFinding {
  kind: "secret";
  id: string;
  severity: string;
  target: string;
  line: number;
}
export type Finding = VulnFinding | SecretFinding;

export interface Waiver {
  waiverId: string;
  findingId: string;
  package?: string;
  severity: string;
  rationale: string;
  signerKind: string;
  signerId: string;
  reviewerId: string;
  independentReviewRef: string;
  expiresAt: string;
}
/** Risk acceptance for a HIGH vulnerability that has no fix. Created by a human principal, never by an agent. */
export interface Acceptance {
  acceptanceId: string;
  cve: string;
  package: string;
  /** Image name (key in the release image set, e.g. "api") or the lockfile path as trivy reports it. */
  artifact: string;
  justification: string;
  acceptedBy: { kind: string; id: string };
  reviewer: string;
  createdAt: string;
  expiresAt: string;
}
export interface PolicyContext {
  /** The image name or "lockfiles" being evaluated; matched against Acceptance.artifact. */
  artifact?: string;
  acceptances?: Acceptance[];
}
export interface Blocker {
  kind: Finding["kind"];
  id: string;
  target: string;
  rule: "CRITICAL" | "HIGH_WITH_FIX" | "HIGH_NO_FIX_UNACCEPTED" | "SECRET";
  detail: string;
}
export interface PolicyVerdict {
  verdict: "PASS" | "BLOCK";
  rule: string;
  blockers: Blocker[];
  waived: Array<{ id: string; waiverId: string; expiresAt: string }>;
  invalidWaivers: Array<{ waiverId: string; reason: string }>;
  accepted: Array<{ id: string; acceptanceId: string; expiresAt: string }>;
  invalidAcceptances: Array<{ acceptanceId: string; reason: string }>;
  informational: { highNoFix: number; highNoFixAccepted: number; total: number };
}
export const POLICY_RULE =
  "BLOCK on CRITICAL (never waivable), BLOCK on HIGH with a fixed version available unless a valid unexpired SEC22 waiver exists, BLOCK on any secret; HIGH without a fix BLOCKs unless it has a valid unexpired risk acceptance (max 30 days, human acceptor, independent reviewer); a fix becoming available voids the acceptance";

export function waiverProblem(w: Waiver, now: Date): string | null {
  if (w.severity.toUpperCase() === "CRITICAL") return "a critical finding is never waivable (SEC22)";
  if (w.signerKind !== "human") return "signer is not a human";
  if (!w.reviewerId || w.reviewerId === w.signerId) return "no independent reviewer";
  if (!w.independentReviewRef) return "no independent review reference";
  if ((w.rationale ?? "").length < 20) return "rationale too short";
  const exp = Date.parse(w.expiresAt);
  if (!Number.isFinite(exp)) return "no expiry";
  if (exp <= now.getTime()) return "expired";
  return null;
}

export function acceptanceProblem(a: Acceptance, now: Date): string | null {
  if (!a.cve || !a.package || !a.artifact) return "cve, package and artifact are required";
  if (a.acceptedBy?.kind !== "human" || !a.acceptedBy.id) return "accepted-by is not a human principal";
  if (!a.reviewer || a.reviewer === a.acceptedBy.id) return "no independent reviewer";
  if ((a.justification ?? "").length < 20) return "justification too short";
  const created = Date.parse(a.createdAt);
  const exp = Date.parse(a.expiresAt);
  if (!Number.isFinite(created)) return "no created date";
  if (!Number.isFinite(exp)) return "no expiry";
  if (created > now.getTime()) return "created in the future";
  if (exp <= created) return "expiry precedes creation";
  if (exp - created > MAX_ACCEPTANCE_DAYS * 86_400_000) return `validity exceeds ${MAX_ACCEPTANCE_DAYS} days`;
  if (exp <= now.getTime()) return "expired";
  return null;
}

export function readAcceptances(file = ACCEPTANCE_FILE): Acceptance[] {
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { acceptances: Acceptance[] }).acceptances
    : [];
}

export function readWaivers(file = WAIVER_FILE): Waiver[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { waivers: Waiver[] }).waivers : [];
}

export function evaluatePolicy(
  findings: Finding[],
  waivers: Waiver[],
  now = new Date(),
  ctx: PolicyContext = {},
): PolicyVerdict {
  const acceptances = ctx.acceptances ?? readAcceptances();
  const invalidAcceptances: PolicyVerdict["invalidAcceptances"] = [];
  const validAcc: Acceptance[] = [];
  for (const a of acceptances) {
    const p = acceptanceProblem(a, now);
    if (p) invalidAcceptances.push({ acceptanceId: a.acceptanceId, reason: p });
    else validAcc.push(a);
  }
  const accepted: PolicyVerdict["accepted"] = [];
  let highNoFixAccepted = 0;
  const invalidWaivers: PolicyVerdict["invalidWaivers"] = [];
  const valid: Waiver[] = [];
  for (const w of waivers) {
    const p = waiverProblem(w, now);
    if (p) invalidWaivers.push({ waiverId: w.waiverId, reason: p });
    else valid.push(w);
  }
  const blockers: Blocker[] = [];
  const waived: PolicyVerdict["waived"] = [];
  let highNoFix = 0;
  for (const f of findings) {
    if (f.kind === "secret") {
      blockers.push({
        kind: "secret",
        id: f.id,
        target: `${f.target}:${f.line}`,
        rule: "SECRET",
        detail: `${f.severity} secret`,
      });
      continue;
    }
    if (f.severity === "CRITICAL") {
      blockers.push({
        kind: "vulnerability",
        id: f.id,
        target: f.target,
        rule: "CRITICAL",
        detail: `${f.pkg}@${f.installed} (${f.status}${f.fixed ? `, fix ${f.fixed}` : ", no fix"})`,
      });
    } else if (f.severity === "HIGH") {
      if (!f.fixed) {
        highNoFix++;
        const a = validAcc.find(
          (x) =>
            x.cve === f.id && x.package === f.pkg && (x.artifact === f.target || x.artifact === ctx.artifact),
        );
        if (a) {
          highNoFixAccepted++;
          accepted.push({ id: f.id, acceptanceId: a.acceptanceId, expiresAt: a.expiresAt });
        } else
          blockers.push({
            kind: "vulnerability",
            id: f.id,
            target: f.target,
            rule: "HIGH_NO_FIX_UNACCEPTED",
            detail: `${f.pkg}@${f.installed} no fix, no valid risk acceptance for ${ctx.artifact ?? f.target}`,
          });
        continue;
      }
      const w = valid.find((x) => x.findingId === f.id && (!x.package || x.package === f.pkg));
      if (w) waived.push({ id: f.id, waiverId: w.waiverId, expiresAt: w.expiresAt });
      else
        blockers.push({
          kind: "vulnerability",
          id: f.id,
          target: f.target,
          rule: "HIGH_WITH_FIX",
          detail: `${f.pkg}@${f.installed} fix ${f.fixed}`,
        });
    }
  }
  return {
    verdict: blockers.length ? "BLOCK" : "PASS",
    rule: POLICY_RULE,
    blockers,
    waived,
    invalidWaivers,
    accepted,
    invalidAcceptances,
    informational: { highNoFix, highNoFixAccepted, total: findings.length },
  };
}

/** Normalise trivy JSON output. */
export function parseTrivy(json: string): Finding[] {
  const d = JSON.parse(json) as {
    Results?: Array<{
      Target: string;
      Vulnerabilities?: Array<{
        VulnerabilityID: string;
        PkgName: string;
        InstalledVersion: string;
        FixedVersion?: string;
        Severity: string;
        Status?: string;
      }>;
      Secrets?: Array<{ RuleID: string; Severity: string; StartLine: number }>;
    }>;
  };
  const out: Finding[] = [];
  for (const r of d.Results ?? []) {
    for (const v of r.Vulnerabilities ?? [])
      out.push({
        kind: "vulnerability",
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        installed: v.InstalledVersion,
        fixed: v.FixedVersion ? v.FixedVersion : null,
        severity: v.Severity,
        status: v.Status ?? "unknown",
        target: r.Target,
      });
    for (const s of r.Secrets ?? [])
      out.push({ kind: "secret", id: s.RuleID, severity: s.Severity, target: r.Target, line: s.StartLine });
  }
  return out;
}

export function trivyBin(): string {
  const local = join(APP, ".toolchain", "bin", "trivy");
  return process.env.TRIVY_BIN ?? (existsSync(local) ? local : "trivy");
}
export interface ScannerInfo {
  name: "trivy";
  version: string;
  binarySha256: string | null;
  dbVersion: number | null;
  dbUpdatedAt: string | null;
  dbDownloadedAt: string | null;
  pinnedVersion: string;
  pinOk: boolean;
}
const env = () => ({ ...process.env, TRIVY_CACHE_DIR: process.env.TRIVY_CACHE_DIR ?? TRIVY_CACHE });

export function scannerInfo(): ScannerInfo | null {
  const bin = trivyBin();
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", env: env() });
  if (r.status !== 0) return null;
  const version = /Version:\s*(\S+)/.exec(r.stdout)?.[1] ?? "";
  const db = (k: string) =>
    new RegExp(`${k}:\\s*(.+)`).exec(r.stdout.split("Vulnerability DB:")[1] ?? "")?.[1]?.trim();
  const toIso = (s?: string) =>
    s ? new Date(s.replace(/\s\+0000 UTC.*$/, "Z").replace(" ", "T")).toISOString() : null;
  let sha: string | null;
  try {
    const path = bin === "trivy" ? spawnSync("which", ["trivy"], { encoding: "utf8" }).stdout.trim() : bin;
    sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    sha = null;
  }
  const pinned = Object.values(TRIVY_LOCK.binarySha256);
  return {
    name: "trivy",
    version,
    binarySha256: sha,
    dbVersion: Number(db("Version")) || null,
    dbUpdatedAt: toIso(db("UpdatedAt")),
    dbDownloadedAt: toIso(db("DownloadedAt")),
    pinnedVersion: TRIVY_LOCK.version,
    pinOk: version === TRIVY_LOCK.version && sha !== null && pinned.includes(sha),
  };
}

const SKIP_DIRS = [
  "**/node_modules",
  "**/.toolchain",
  "**/.data",
  "**/.venv",
  "**/.next",
  "**/.next-perf",
  "**/test-results",
  "**/dist",
  "**/target",
  "**/.git",
];

function runTrivy(args: string[]): Finding[] {
  mkdirSync(env().TRIVY_CACHE_DIR!, { recursive: true });
  // Without --live the cached DB is used as is (no network); the release CLI and live runs refresh it.
  const offline =
    !process.env.NEARESIS_ACCEPT_LIVE && existsSync(join(env().TRIVY_CACHE_DIR!, "db", "trivy.db"));
  const r = spawnSync(
    trivyBin(),
    [args[0]!, "--quiet", ...(offline ? ["--skip-db-update"] : []), ...args.slice(1), "--format", "json"],
    {
      encoding: "utf8",
      env: env(),
      maxBuffer: 512 * 1024 * 1024,
      timeout: 900_000,
    },
  );
  if (r.status !== 0) throw new Error(`trivy failed (${r.status}): ${(r.stderr || r.stdout).slice(-400)}`);
  return parseTrivy(r.stdout);
}
const SCAN = ["--scanners", "vuln,secret", "--severity", "CRITICAL,HIGH", "--include-dev-deps"];

/** Filesystem scan of lockfiles (pnpm-lock.yaml, uv.lock, package-lock.json, Cargo.lock) and secrets. */
export function scanFs(dir: string): Finding[] {
  return runTrivy([
    "fs",
    ...SCAN,
    ...SKIP_DIRS.flatMap((d) => ["--skip-dirs", d]),
    "--skip-files",
    "**/.env",
    dir,
  ]);
}
/** Local image scan (docker engine, no pull, no push). Runtime dependencies only: dev dependencies are not in an image. */
export function scanImage(tag: string): Finding[] {
  return runTrivy(["image", "--image-src", "docker", ...SCAN.filter((a) => a !== "--include-dev-deps"), tag]);
}

export interface ImageScanResult {
  tag: string;
  digest: string;
  findings: number;
  critical: number;
  high: number;
  highWithFix: number;
  secrets: number;
  verdict: PolicyVerdict;
}
export interface ScanRecord {
  status: "RAN";
  scanner: ScannerInfo;
  scannedAt: string;
  policy: string;
  verdict: "PASS" | "BLOCK";
  lockfiles: { findings: number; verdict: PolicyVerdict };
  images: Record<string, ImageScanResult>;
}
export interface NotRunRecord {
  status: "NOT_RUN";
  reason: string;
}

/**
 * A temporary tree holding a lockfile that pins a known-vulnerable package (decode-uri-component 0.2.2, fix available) and a
 * file with a credential-shaped token assembled at run time (no literal in the repository). Negative control for the scanners.
 */
export function plantedArtifactDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vuln-planted-"));
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({
      name: "planted",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "planted", version: "1.0.0", dependencies: { "decode-uri-component": "0.2.2" } },
        "node_modules/decode-uri-component": {
          version: "0.2.2",
          resolved: "https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.2.2.tgz",
        },
      },
    }),
  );
  const rnd = (n: number) =>
    createHash("sha256")
      .update(String(Math.random()))
      .digest("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, n);
  writeFileSync(
    join(dir, "config.txt"),
    `aws_access_key_id = AKIA${rnd(16)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "Q")
      .padEnd(16, "Q")}\naws_secret_access_key = ${rnd(40)}\ntoken = ghp_${rnd(36)}\n`,
  );
  return dir;
}

const count = (f: Finding[], pred: (x: Finding) => boolean) => f.filter(pred).length;
export function summariseImage(tag: string, digest: string, f: Finding[], v: PolicyVerdict): ImageScanResult {
  return {
    tag,
    digest,
    findings: f.length,
    critical: count(f, (x) => x.kind === "vulnerability" && x.severity === "CRITICAL"),
    high: count(f, (x) => x.kind === "vulnerability" && x.severity === "HIGH"),
    highWithFix: count(f, (x) => x.kind === "vulnerability" && x.severity === "HIGH" && !!x.fixed),
    secrets: count(f, (x) => x.kind === "secret"),
    verdict: v,
  };
}

/** Scan the lockfiles under `dir` and each built image; every verdict uses the waiver file. */
export function scanRelease(opts: {
  dir: string;
  images: Record<string, { tag: string; digest: string }>;
  now?: Date;
}): ScanRecord | NotRunRecord {
  const scanner = scannerInfo();
  if (!scanner) return { status: "NOT_RUN", reason: "trivy is not installed (run scripts/toolchain-env.sh)" };
  const waivers = readWaivers();
  const lock = scanFs(opts.dir);
  const lockVerdict = evaluatePolicy(lock, waivers, opts.now, { artifact: "lockfiles" });
  const images: Record<string, ImageScanResult> = {};
  for (const [name, img] of Object.entries(opts.images)) {
    const f = scanImage(img.tag);
    images[name] = summariseImage(
      img.tag,
      img.digest,
      f,
      evaluatePolicy(f, waivers, opts.now, { artifact: name }),
    );
  }
  const all = [lockVerdict, ...Object.values(images).map((i) => i.verdict)];
  return {
    status: "RAN",
    scanner,
    scannedAt: (opts.now ?? new Date()).toISOString(),
    policy: POLICY_RULE,
    verdict: all.every((v) => v.verdict === "PASS") ? "PASS" : "BLOCK",
    lockfiles: { findings: lock.length, verdict: lockVerdict },
    images,
  };
}

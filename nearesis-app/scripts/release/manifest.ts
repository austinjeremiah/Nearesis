/** Release manifest, rollback manifest and SBOM record (ch.17 "Release manifest"). Hash-only; never carries secrets. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

export const MAINNET_ACTIONS = ["commit_preregistration_hash"] as const;
export const REQUIRED_FIELDS = [
  "gitSha",
  "images",
  "semanticModelSha",
  "pluginManifestSetSha",
  "sourceSnapshotSha",
  "preregistrationSha",
  "testSuiteReportSha",
  "testnetTxHash",
  "approver",
  "mainnetAllowedActions",
  "expectedMaxSpend",
] as const;
/** The 12th required item of N06(a) is the images record's three members. */
export const IMAGE_KEYS = ["api", "worker", "web"] as const;

export interface ReleaseManifest {
  gitSha: string | null;
  images: { api: string | null; worker: string | null; web: string | null };
  semanticModelSha: string | null;
  pluginManifestSetSha: string | null;
  sourceSnapshotSha: string | null;
  preregistrationSha: string | null;
  testSuiteReportSha: string | null;
  testnetTxHash: string | null;
  approver: string | null;
  mainnetAllowedActions: string[];
  expectedMaxSpend: string | null;
  /** Shared with SEC11 evidence (`sbomSha256`). */
  sbomSha256: string | null;
  balanceCeiling: string | null;
  feeCeiling: string | null;
  rollbackManifestSha: string | null;
}
export interface RollbackManifest {
  previousGitSha: string | null;
  previousImages: { api: string | null; worker: string | null; web: string | null };
  migrationCompatibility: { from: string; to: string; strategy: "expand-contract"; destructive: string[] };
  frozenMetricVersions: Record<string, string>;
}
export interface Problem {
  field: string;
  problem: string;
}

export const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir).sort()) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
/** Deterministic hash over files: sorted relative paths and contents. */
export function hashPaths(root: string, paths: string[]): string {
  const files = paths.flatMap((p) => {
    const abs = join(root, p);
    return existsSync(abs) && statSync(abs).isDirectory() ? walk(abs) : existsSync(abs) ? [abs] : [];
  });
  const h = createHash("sha256");
  for (const f of files.sort()) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return `sha256:${h.digest("hex")}`;
}

export interface BuildInputs {
  root: string;
  gitSha?: string;
  images?: Partial<ReleaseManifest["images"]>;
  testnetTxHash?: string | null;
  approver?: string | null;
  expectedMaxSpend?: string | null;
  sbomSha256?: string | null;
  balanceCeiling?: string;
  feeCeiling?: string;
  /** Previous release for the rollback manifest. */
  previous?: { gitSha: string; images: Partial<ReleaseManifest["images"]> } | null;
}

export function scanMigrations(root: string): {
  from: string;
  to: string;
  destructive: string[];
  files: number;
} {
  const dirs = [
    "packages/kernel/migrations",
    "packages/workflow/migrations",
    "services/ingestion/migrations",
    "services/analytics/pg/migrations",
  ];
  const destructive: string[] = [];
  const names: string[] = [];
  for (const d of dirs)
    for (const f of walk(join(root, d)).filter((x) => x.endsWith(".sql"))) {
      names.push(relative(root, f));
      const sql = readFileSync(f, "utf8").replace(/--.*$/gm, "");
      const bad =
        /\b(drop\s+(table|column|schema)|truncate|delete\s+from|rename\s+(to|column)|alter\s+column\s+\S+\s+(set\s+data\s+)?type)\b/i.exec(
          sql,
        );
      if (bad) destructive.push(`${relative(root, f)}: ${bad[0].toLowerCase()}`);
      for (const m of sql.matchAll(/drop\s+constraint\s+(?:if\s+exists\s+)?(\w+)/gi))
        if (!new RegExp(`add\\s+constraint\\s+${m[1]}\\b`, "i").test(sql))
          destructive.push(`${relative(root, f)}: drop constraint ${m[1]} without re-add`);
    }
  names.sort();
  return { from: names[0] ?? "", to: names[names.length - 1] ?? "", destructive, files: names.length };
}

export function buildManifest(i: BuildInputs): { manifest: ReleaseManifest; rollback: RollbackManifest } {
  const gitSha =
    i.gitSha ?? spawnSync("git", ["-C", i.root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const freezePath = join(i.root, "docs/research/PREREGISTRATION.freeze.json");
  const prereg = existsSync(freezePath)
    ? ((JSON.parse(readFileSync(freezePath, "utf8")) as { documentHash?: string }).documentHash ?? null)
    : null;
  const mig = scanMigrations(i.root);
  const rollback: RollbackManifest = {
    previousGitSha: i.previous?.gitSha ?? null,
    previousImages: { api: null, worker: null, web: null, ...i.previous?.images },
    migrationCompatibility: {
      from: mig.from,
      to: mig.to,
      strategy: "expand-contract",
      destructive: mig.destructive,
    },
    frozenMetricVersions: { "docs/metrics/METRICS.md": hashPaths(i.root, ["docs/metrics/METRICS.md"]) },
  };
  const manifest: ReleaseManifest = {
    gitSha: gitSha || null,
    images: { api: null, worker: null, web: null, ...i.images },
    semanticModelSha: hashPaths(i.root, ["packages/semantic-gateway/src", "docs/metrics"]),
    pluginManifestSetSha: hashPaths(i.root, ["plugins/near-thesis/src/manifest.ts"]),
    sourceSnapshotSha: hashPaths(i.root, ["packages/capsule/fixtures/snapshot-synthetic"]),
    preregistrationSha: prereg,
    testSuiteReportSha: hashPaths(i.root, ["tests/TEST_INDEX.json"]),
    testnetTxHash: i.testnetTxHash ?? null,
    approver: i.approver ?? null,
    mainnetAllowedActions: [...MAINNET_ACTIONS],
    expectedMaxSpend: i.expectedMaxSpend ?? null,
    sbomSha256: i.sbomSha256 ?? null,
    balanceCeiling: i.balanceCeiling ?? null,
    feeCeiling: i.feeCeiling ?? null,
    rollbackManifestSha: `sha256:${sha256(JSON.stringify(rollback))}`,
  };
  return { manifest, rollback };
}

const SHA = /^sha256:[0-9a-f]{64}$/;
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["near ed25519 secret key", /ed25519:[1-9A-HJ-NP-Za-km-z]{64,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/],
  ["long hex key", /\b[0-9a-f]{128}\b/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._-]{20,}/i],
];
export function scanSecrets(value: unknown): Problem[] {
  const out: Problem[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const [n, re] of SECRET_PATTERNS)
        if (re.test(v)) out.push({ field: path, problem: `contains ${n}` });
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k);
    }
  };
  visit(value, "");
  return out;
}

export function validateManifest(m: Partial<ReleaseManifest> & Record<string, unknown>): Problem[] {
  const p: Problem[] = [];
  const isNull = (x: unknown) => x === null || x === undefined || x === "";
  const placeholder = (x: string) => /[<>]|\.\.\.|^0x0+$|^(sha256:)?0{64}$|placeholder|todo/i.test(x);
  if (isNull(m.gitSha) || !/^[0-9a-f]{40}$/.test(String(m.gitSha)))
    p.push({ field: "gitSha", problem: "missing or not a 40-hex commit" });
  for (const k of IMAGE_KEYS) {
    const v = m.images?.[k];
    if (isNull(v)) p.push({ field: `images.${k}`, problem: "missing image digest" });
    else if (!SHA.test(String(v)) || placeholder(String(v)))
      p.push({ field: `images.${k}`, problem: "not a real sha256 digest" });
  }
  for (const f of [
    "semanticModelSha",
    "pluginManifestSetSha",
    "sourceSnapshotSha",
    "preregistrationSha",
    "testSuiteReportSha",
  ] as const) {
    const v = m[f];
    if (isNull(v)) p.push({ field: f, problem: "missing" });
    else if (!SHA.test(String(v)) || placeholder(String(v)))
      p.push({ field: f, problem: "placeholder or malformed hash" });
  }
  if (isNull(m.testnetTxHash))
    p.push({ field: "testnetTxHash", problem: "missing: needs a confirmed testnet transaction (human-run)" });
  else if (placeholder(String(m.testnetTxHash))) p.push({ field: "testnetTxHash", problem: "placeholder" });
  if (isNull(m.approver)) p.push({ field: "approver", problem: "missing human approver id" });
  const acts = m.mainnetAllowedActions;
  if (!Array.isArray(acts) || acts.length !== 1 || acts[0] !== MAINNET_ACTIONS[0])
    p.push({ field: "mainnetAllowedActions", problem: `must equal exactly ["${MAINNET_ACTIONS[0]}"]` });
  if (isNull(m.expectedMaxSpend) || !/^\d+(\.\d+)? (NEAR|yoctoNEAR)$/.test(String(m.expectedMaxSpend)))
    p.push({ field: "expectedMaxSpend", problem: "must be an explicit amount such as '0.05 NEAR'" });
  if (!isNull(m.sbomSha256) && !/^[0-9a-f]{64}$/.test(String(m.sbomSha256)))
    p.push({ field: "sbomSha256", problem: "malformed" });
  p.push(...scanSecrets(m).map((s) => ({ field: s.field || "(manifest)", problem: s.problem })));
  return p;
}

/** Each hash in the manifest must equal the recomputed hash of the artefact it names. */
export function verifyHashes(
  m: ReleaseManifest,
  root: string,
  builtImages: Partial<ReleaseManifest["images"]> = {},
): Problem[] {
  const re = buildManifest({ root, gitSha: m.gitSha ?? undefined }).manifest;
  const p: Problem[] = [];
  for (const f of [
    "semanticModelSha",
    "pluginManifestSetSha",
    "sourceSnapshotSha",
    "preregistrationSha",
    "testSuiteReportSha",
  ] as const)
    if (m[f] !== re[f]) p.push({ field: f, problem: "does not match the recomputed artefact hash" });
  for (const k of IMAGE_KEYS)
    if (m.images[k] !== (builtImages[k] ?? null))
      p.push({ field: `images.${k}`, problem: "digest does not match the built image" });
  return p;
}

export function validateRollback(r: RollbackManifest, current: ReleaseManifest): Problem[] {
  const p: Problem[] = [];
  if (!r.previousGitSha) p.push({ field: "rollback.previousGitSha", problem: "missing" });
  for (const k of IMAGE_KEYS)
    if (!r.previousImages[k] || !SHA.test(r.previousImages[k]!))
      p.push({ field: `rollback.previousImages.${k}`, problem: "missing digest" });
  if (!r.migrationCompatibility.from || !r.migrationCompatibility.to)
    p.push({ field: "rollback.migrationCompatibility", problem: "missing range" });
  if (r.migrationCompatibility.destructive.length)
    p.push({
      field: "rollback.migrationCompatibility",
      problem: `destructive migrations: ${r.migrationCompatibility.destructive.join("; ")}`,
    });
  if (!Object.keys(r.frozenMetricVersions).length)
    p.push({ field: "rollback.frozenMetricVersions", problem: "missing" });
  if (current.rollbackManifestSha !== `sha256:${sha256(JSON.stringify(r))}`)
    p.push({ field: "rollbackManifestSha", problem: "does not match the rollback manifest" });
  return p;
}

export const manifestHash = (m: ReleaseManifest) => sha256(JSON.stringify(m));

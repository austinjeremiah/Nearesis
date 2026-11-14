/**
 * Shared PERF plumbing (ch.16b section 6.2 "Reference environment and thresholds").
 *  - A PERF test refuses to produce a verdict unless the reference-environment ADR (ADR-20261111-002) is FROZEN, its
 *    own source file and `reference.json` hash exactly as frozen, and this machine matches the frozen fingerprint.
 *    Otherwise it records `blocked` (never PASS and never FAIL on an unfrozen or foreign environment).
 *  - Results are labelled `environment: "reference"`; they are never mixed with 2-core CI runs.
 *  - PERF_DRYRUN=1 runs the body without any verdict or evidence (harness development only; such numbers are void).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus, loadavg, release, totalmem, type } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(here, "..", "..");
export const REPO_ROOT = resolve(APP_ROOT, "..");
export const ADR_PATH = join(
  REPO_ROOT,
  "NEARESIS_Build_Bible",
  "reports",
  "DECISIONS",
  "ADR-20261111-002.md",
);
export const REFERENCE_PATH = join(here, "reference.json");
export const DRYRUN = process.env.PERF_DRYRUN === "1";

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const sha256Text = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface Reference {
  frozenAt: string;
  environment: Record<string, unknown>;
  thresholds: Record<string, Record<string, number>>;
  fixtures: Record<string, string>;
}
export const reference = (): Reference => JSON.parse(readFileSync(REFERENCE_PATH, "utf8")) as Reference;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}
export function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    n: s.length,
    min: round(s[0] ?? NaN),
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s[s.length - 1] ?? NaN),
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

/** Machine fingerprint compared with the frozen one (the same facts C18's reference environment uses). */
export function fingerprint(): Record<string, unknown> {
  return {
    cpuModel: cpus()[0]!.model,
    cpuCores: cpus().length,
    ramGiB: Math.round(totalmem() / 2 ** 30),
    os: `${type()} ${release()}`,
    arch: process.arch,
    node: process.version,
  };
}

export type Gate =
  | { ok: true; referenceSha256: string; adrSha256: string; fingerprint: Record<string, unknown> }
  | { ok: false; reason: string };

/** `testFile` is `import.meta.url` of the caller; its hash must equal the one frozen in the ADR. */
export function gate(testFile: string, extraFiles: string[] = []): Gate {
  if (!existsSync(ADR_PATH))
    return { ok: false, reason: "ADR-20261111-002 is missing: reference environment not frozen" };
  if (!existsSync(REFERENCE_PATH)) return { ok: false, reason: "tests/perf/reference.json is missing" };
  const adr = readFileSync(ADR_PATH, "utf8");
  if (!/^Status:\s*FROZEN\b/m.test(adr))
    return { ok: false, reason: "ADR-20261111-002 is not FROZEN: results before the freeze are void" };
  const refSha = sha256File(REFERENCE_PATH);
  if (!adr.includes(refSha))
    return { ok: false, reason: "reference.json differs from the version frozen in the ADR" };
  for (const f of [fileURLToPath(testFile), join(here, "_reference.ts"), ...extraFiles]) {
    if (!adr.includes(sha256File(f)))
      return { ok: false, reason: `${f.replace(APP_ROOT, "")} differs from the version frozen in the ADR` };
  }
  const ref = reference();
  const fp = fingerprint();
  const mismatch = Object.entries(ref.environment).filter(([k, v]) => k in fp && fp[k] !== v);
  if (mismatch.length)
    return {
      ok: false,
      reason: `this machine differs from the frozen reference environment: ${JSON.stringify(mismatch)}`,
    };
  return { ok: true, referenceSha256: refSha, adrSha256: sha256Text(adr), fingerprint: fp };
}

/** Conditions at measurement time, recorded with every result (the machine is shared with other agents). */
export function conditions() {
  const [l1, l5, l15] = loadavg();
  return { loadAvg: [l1, l5, l15].map((x) => Math.round(x! * 100) / 100), at: new Date().toISOString() };
}

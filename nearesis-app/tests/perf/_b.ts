/**
 * Plumbing for PERF05-PERF12. These tests reuse the ADR-20261111-002 reference profile and gate (see _reference.ts) and
 * keep their own thresholds and fixture hashes in reference-b.json, so the frozen PERF01-PERF04 files stay untouched.
 * A PERF05-PERF12 verdict is only produced once the ADR lists the sha256 of the test file, of this file, of
 * reference-b.json and of reference.json; until then the test records BLOCKED_DEPENDENCY (PERF_DRYRUN=1 runs the body
 * without any verdict or evidence: harness development only, numbers are void).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { conditions, gate, type Gate } from "./_reference.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REFERENCE_B_PATH = join(here, "reference-b.json");
export const referenceB = (): {
  thresholds: Record<string, Record<string, number>>;
  fixtures: Record<string, string>;
} => JSON.parse(readFileSync(REFERENCE_B_PATH, "utf8"));
export const thr = (id: string): Record<string, number> => referenceB().thresholds[id]!;

export const gateB = (testFile: string, extra: string[] = []): Gate =>
  gate(testFile, [REFERENCE_B_PATH, join(here, "_b.ts"), ...extra]);

export function evidenceBase(
  g: Gate,
  extra: { dataset: Record<string, unknown>; concurrency: unknown; cacheState: string },
) {
  return {
    environment: "reference" as const,
    profile: g.ok ? g.fingerprint : null,
    referenceSha256: g.ok ? g.referenceSha256 : null,
    adrSha256: g.ok ? g.adrSha256 : null,
    conditions: conditions(),
    ...extra,
  };
}

/** Histogram of samples into fixed bucket upper bounds (ms), for the latency-histogram evidence. */
export function histogram(samples: number[], bounds = [10, 25, 50, 100, 250, 500, 1000, 1500, 3000, 10000]) {
  const out: Record<string, number> = {};
  for (const b of bounds) out[`<=${b}`] = 0;
  out[`>${bounds[bounds.length - 1]}`] = 0;
  for (const s of samples) {
    const b = bounds.find((x) => s <= x);
    out[b === undefined ? `>${bounds[bounds.length - 1]}` : `<=${b}`]!++;
  }
  return out;
}

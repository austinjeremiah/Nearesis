import { parseValues, pearsonPpm } from "@nearesis/capsule";
import type { VerifierInputFile } from "./facts.ts";

/**
 * Numbers of `relationship-v2` that the pinned verifier does not compute. They are recomputed by the API in exact integer
 * arithmetic (BigInt) from the capsule's frozen, exactly scaled series, on Verify and on Rerun, so anyone can repeat them:
 *  - correlation of day-over-day CHANGES (first differences of the two series, then the same Pearson as the verifier);
 *  - rank (Spearman) correlation of the levels (average ranks for ties, Pearson on the ranks);
 *  - a 95% interval for the level correlation by a MOVING-BLOCK BOOTSTRAP with a fixed seed taken from the capsule hash,
 *    block length 7 days, 1000 resamples; the interval is the 2.5th and 97.5th percentile of the resampled correlations.
 * The level correlations at lag 0 and lag 7 are attested by the verifier (WASM cross-check, OutLayer proof); everything
 * else here is recomputed by the API and is NOT part of the verifier's attestation.
 */
export const BOOTSTRAP = { resamples: 1000, blockLength: 7, levelPct: 95 } as const;

const ppmOf = (x: bigint[], y: bigint[]): bigint | null => {
  if (x.length < 3) return null;
  const r = pearsonPpm(x, y);
  return r === null ? null : BigInt(r);
};
const diff = (a: bigint[]): bigint[] => a.slice(1).map((v, i) => v - a[i]!);

/** Average ranks, doubled so they stay integers (a tie of positions a..b gets a + b). */
export function rank2(v: bigint[]): bigint[] {
  const idx = v.map((_, i) => i).sort((p, q) => (v[p]! < v[q]! ? -1 : v[p]! > v[q]! ? 1 : p - q));
  const out = new Array<bigint>(v.length).fill(0n);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && v[idx[j + 1]!] === v[idx[i]!]) j++;
    for (let k = i; k <= j; k++) out[idx[k]!] = BigInt(i + 1 + (j + 1));
    i = j + 1;
  }
  return out;
}

/** Deterministic 32-bit generator (mulberry32 over integer operations only). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) >>> 0;
  };
}
/** The seed: the first eight hex digits of the capsule hash. */
export const seedOf = (capsuleHash: string): number => parseInt(capsuleHash.slice(0, 8), 16) >>> 0;

export interface Interval {
  loPpm: bigint;
  hiPpm: bigint;
  resamples: number;
  validResamples: number;
  blockLength: number;
  seed: string;
}

export function blockBootstrap(x: bigint[], y: bigint[], capsuleHash: string): Interval | null {
  const m = x.length;
  if (m < 10) return null;
  const L = Math.min(BOOTSTRAP.blockLength, m);
  const next = prng(seedOf(capsuleHash));
  const blocks = Math.ceil(m / L);
  const out: bigint[] = [];
  for (let r = 0; r < BOOTSTRAP.resamples; r++) {
    const bx: bigint[] = [];
    const by: bigint[] = [];
    for (let b = 0; b < blocks; b++) {
      const start = next() % (m - L + 1);
      for (let k = 0; k < L && bx.length < m; k++) {
        bx.push(x[start + k]!);
        by.push(y[start + k]!);
      }
    }
    const v = ppmOf(bx, by);
    if (v !== null) out.push(v);
  }
  if (out.length < BOOTSTRAP.resamples * 0.9) return null;
  out.sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
  const cut = Math.floor(out.length * 0.025);
  return {
    loPpm: out[cut]!,
    hiPpm: out[out.length - 1 - cut]!,
    resamples: BOOTSTRAP.resamples,
    validResamples: out.length,
    blockLength: L,
    seed: capsuleHash.slice(0, 8),
  };
}

export interface RelationshipStats {
  /** Number of aligned pairs the primary correlation uses (n minus the lag). */
  pairs: number;
  lagDays: number;
  levelPpm: bigint | null;
  changePpm: bigint | null;
  spearmanPpm: bigint | null;
  interval: Interval | null;
}

/** `lagDays` 0: same day; k: x on day t against y on day t + k (the verifier's `lag_pearson:k` pairing). */
export function relationshipStats(
  input: Pick<VerifierInputFile, "series">,
  lagDays: number,
  capsuleHash: string,
): RelationshipStats {
  const xAll = parseValues(input.series.x.points);
  const yAll = parseValues(input.series.y.points);
  const n = xAll.length;
  const x = lagDays > 0 ? xAll.slice(0, n - lagDays) : xAll;
  const y = lagDays > 0 ? yAll.slice(lagDays) : yAll;
  return {
    pairs: x.length,
    lagDays,
    levelPpm: ppmOf(x, y),
    changePpm: ppmOf(diff(x), diff(y)),
    spearmanPpm: x.length >= 3 ? ppmOf(rank2(x), rank2(y)) : null,
    interval: blockBootstrap(x, y, capsuleHash),
  };
}

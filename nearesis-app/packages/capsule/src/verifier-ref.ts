import { canonicalSha256 } from "./canonical.ts";

/**
 * TypeScript port of services/outlayer-verifier (spec in its README): exact integer arithmetic with bigint.
 * It is checked byte-for-byte against the WASM fixtures' digests. It is the *local* recomputation; it is never an
 * OutLayer proof.
 */
export interface VerifierSeries {
  name: string;
  unit: string;
  points: Array<[string, string]>;
}
export interface VerifierInput {
  schema_version: "nearesis.verifier.input.v1";
  claim_id: string;
  source: { dataset: string; snapshot_id: string; synthetic: boolean };
  series: { x: VerifierSeries; y: VerifierSeries };
  metrics: string[];
  expected?: { input_sha256?: string; results_sha256: string };
}

export function rdiv(a: bigint, b: bigint): bigint {
  const abs = a < 0n ? -a : a;
  const q = (2n * abs + b) / (2n * b);
  return a < 0n ? -q : q;
}

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function summary(v: bigint[]) {
  const n = BigInt(v.length);
  const sum = v.reduce((a, b) => a + b, 0n);
  const first = v[0]!;
  const last = v[v.length - 1]!;
  let growth: string | null = null;
  if (first !== 0n) {
    const q = rdiv((last - first) * 10_000n, first < 0n ? -first : first);
    growth = (first < 0n ? -q : q).toString();
  }
  return {
    growth_bps: growth,
    max: v.reduce((a, b) => (b > a ? b : a)).toString(),
    mean_micro: rdiv(sum * 1_000_000n, n).toString(),
    min: v.reduce((a, b) => (b < a ? b : a)).toString(),
    sum: sum.toString(),
  };
}

export function pearsonPpm(x: bigint[], y: bigint[]): string | null {
  const n = BigInt(x.length);
  let sx = 0n,
    sy = 0n,
    sxx = 0n,
    syy = 0n,
    sxy = 0n;
  for (let i = 0; i < x.length; i++) {
    const a = x[i]!,
      b = y[i]!;
    sx += a;
    sy += b;
    sxx += a * a;
    syy += b * b;
    sxy += a * b;
  }
  const num = n * sxy - sx * sy;
  const a = n * sxx - sx * sx;
  const b = n * syy - sy * sy;
  if (a <= 0n || b <= 0n) return null;
  const den = isqrt(a * b);
  const abs = num < 0n ? -num : num;
  let q = (2_000_000n * abs + den) / (2n * den);
  if (q > 1_000_000n) q = 1_000_000n;
  return (num < 0n ? -q : q).toString();
}

export function parseValues(points: Array<[string, string]>): bigint[] {
  return points.map(([, v]) => BigInt(v));
}

export function computeResults(input: Pick<VerifierInput, "series" | "metrics">): Record<string, unknown> {
  const x = parseValues(input.series.x.points);
  const y = parseValues(input.series.y.points);
  const r: Record<string, unknown> = { n: String(x.length) };
  const lags: Record<string, string | null> = {};
  for (const m of input.metrics) {
    if (m === "summary") {
      r.x = summary(x);
      r.y = summary(y);
    } else if (m === "pearson") r.pearson_ppm = pearsonPpm(x, y);
    else {
      const k = Number(/^lag_pearson:(\d+)$/.exec(m)?.[1]);
      if (!Number.isInteger(k)) throw new Error(`unknown metric ${m}`);
      lags[String(k)] = pearsonPpm(x.slice(0, x.length - k), y.slice(k));
    }
  }
  if (Object.keys(lags).length) r.lag_pearson_ppm = lags;
  return r;
}

export function inputDigest(input: VerifierInput): string {
  const { expected: _e, ...rest } = input;
  return canonicalSha256(rest);
}

export const resultsDigest = (results: Record<string, unknown>): string => canonicalSha256(results);

const INT = /^-?(0|[1-9][0-9]*)$/;
const MAX_ABS = 10n ** 15n;
const TEXT = /^[\x20-\x7e]*$/;
const ID = /^[A-Za-z0-9._:/-]+$/;

/** Mirrors the verifier's schema bounds so the local path rejects what the WASM rejects. */
const sameKeys = (o: unknown, keys: string[]): boolean =>
  typeof o === "object" && o !== null && Object.keys(o).sort().join() === [...keys].sort().join();

export function validateInput(i: VerifierInput): string | null {
  const top = ["schema_version", "claim_id", "source", "series", "metrics"];
  if (!sameKeys(i, "expected" in i ? [...top, "expected"] : top)) return "unknown_field";
  if (!sameKeys(i.source, ["dataset", "snapshot_id", "synthetic"]) || typeof i.source.synthetic !== "boolean")
    return "unknown_field";
  if (
    !sameKeys(i.series, ["x", "y"]) ||
    !sameKeys(i.series.x, ["name", "unit", "points"]) ||
    !sameKeys(i.series.y, ["name", "unit", "points"])
  )
    return "unknown_field";
  if (i.schema_version !== "nearesis.verifier.input.v1") return "schema_version";
  if (!ID.test(i.claim_id)) return "claim_id";
  for (const t of [
    i.source.dataset,
    i.source.snapshot_id,
    i.series.x.name,
    i.series.x.unit,
    i.series.y.name,
    i.series.y.unit,
  ])
    if (!TEXT.test(t) || t.includes('"') || t.includes("\\")) return "text";
  const px = i.series.x.points,
    py = i.series.y.points;
  if (px.length < 2 || px.length > 4096 || px.length !== py.length) return "series_length";
  let prev: number | null = null;
  for (let k = 0; k < px.length; k++) {
    const [dx, vx] = px[k]!;
    const [dy, vy] = py[k]!;
    if (dx !== dy || !/^\d{4}-\d{2}-\d{2}$/.test(dx)) return "dates";
    const t = Date.parse(`${dx}T00:00:00Z`);
    if (Number.isNaN(t) || (prev !== null && t - prev !== 86_400_000)) return "date_gap";
    prev = t;
    for (const v of [vx, vy]) {
      if (typeof v !== "string" || !INT.test(v)) return "value_format";
      const b = BigInt(v);
      if (b > MAX_ABS || b < -MAX_ABS) return "value_bounds";
    }
  }
  const sorted = [...i.metrics].sort();
  if (
    i.metrics.length === 0 ||
    sorted.some((m, k) => m !== i.metrics[k]) ||
    new Set(i.metrics).size !== i.metrics.length
  )
    return "metrics_order";
  let lagCount = 0;
  for (const m of i.metrics) {
    if (m === "summary" || m === "pearson") continue;
    const k = /^lag_pearson:(\d+)$/.exec(m)?.[1];
    if (!k || Number(k) < 1 || Number(k) > 90 || Number(k) > px.length - 2) return "metric_name";
    lagCount++;
  }
  return lagCount > 4 ? "too_many_lags" : null;
}

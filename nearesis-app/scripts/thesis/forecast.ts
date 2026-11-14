/**
 * Forecast engine for the reference thesis. Pure and deterministic: no network, no clock, no model call. Every random draw comes
 * from a PRNG seeded by the hash of the input, so the same input gives the same file byte for byte.
 *
 * Method (fixed before the results are read; see FORECAST_THESIS_CONTRACT):
 *  - Each series is a daily series on one calendar. y[t] = f(7-day mean at t), where the 7-day mean averages the OBSERVED days of
 *    t-6..t (at least `m7Min` of them; a missing or partial day is never filled with zero) and f is ln(1 + x) for amounts and
 *    counts ("log1p"), the logit for shares ("logit", mean clipped to [1e-6, 1 - 1e-6]) or ln(x) for ratios ("log").
 *  - Candidate models on y: naive (last value), drift (random walk with drift from the trailing 180 days), linear trend on the
 *    trailing 180 days, damped trend (Holt, damping 0.9, level/trend smoothing fitted by one-step squared error on a fixed
 *    grid), and the median of drift, trend and damped.
 *  - Target: the 30-day average of the daily series ending at day T+h (observed days only; at least `minObs` of them). The
 *    forecast of it is the mean of the model's back-transformed levels over the same 30 days. Error = |f(forecast) - f(actual)|.
 *  - Rolling-origin backtest: origins every 14 days from day index 150; horizons 30, 60, 90. Skill = 1 - MAE / MAE(naive).
 *    The model with the lowest MAE at 90 days is used (ties: simpler model first).
 *  - Bands: symmetric in f-space, half-width = the 50% / 80% quantile of the chosen model's absolute backtest errors at each
 *    scored horizon, linear between scored horizons, widened by sqrt(horizon / last scored horizon) beyond it (an ASSUMPTION:
 *    the data cannot score longer horizons) and sqrt(h / 30) below the first, never narrowing with the horizon.
 *  - Calibration: share of backtest points whose error is inside the 80% half-width: in sample, leave-one-origin-out, and
 *    forward (width from earlier origins whose target was already known, no leakage); the verdict uses forward when it has six
 *    or more test points.
 *  - Simulation: block bootstrap (block length 14) of the chosen model's demeaned one-step residuals, summed along the path and
 *    added to the model's central path; crossover and total statistics are read from `paths` simulated paths.
 */
import { createHash } from "node:crypto";

export type Transform = "log1p" | "logit" | "log";
export type ModelId = "naive" | "drift" | "trend" | "damped" | "median";
export const MODEL_ORDER: readonly ModelId[] = ["naive", "drift", "trend", "damped", "median"];

export interface SeriesInput {
  id: string;
  label: string;
  unit: string;
  transform: Transform;
  /** Contiguous calendar days (YYYY-MM-DD), identical for every series. */
  days: string[];
  /** Observed daily values; null = missing or partial day (never zero-filled). */
  values: (number | null)[];
}
export interface ForecastConfig {
  firstOrigin: number;
  originStep: number;
  horizons: number[];
  trailing: number;
  avgWindow: number;
  minObs: number;
  m7Min: number;
  pathDays: number;
  paths: number;
  block: number;
  phi: number;
  reportHorizons: number[];
  checkpoints: string[];
  band: { inner: number; outer: number };
  calibrationRange: [number, number];
  skillThreshold: number;
}
export const DEFAULT_CONFIG: ForecastConfig = {
  firstOrigin: 150,
  originStep: 14,
  horizons: [30, 60, 90],
  trailing: 180,
  avgWindow: 30,
  minObs: 15,
  m7Min: 4,
  pathDays: 365,
  paths: 2000,
  block: 14,
  phi: 0.9,
  reportHorizons: [90, 180, 365],
  checkpoints: ["2027-02-13", "2027-05-13", "2027-11-13"],
  band: { inner: 0.5, outer: 0.8 },
  calibrationRange: [0.65, 0.95],
  skillThreshold: 0.1,
};
export interface ForecastInput {
  series: SeriesInput[];
  /** Crossover D1: the first day the 30-day average of series `a` exceeds that of series `b`. */
  crossover?: { a: string; b: string };
  /** 12-month total D2 of a level series (sum of the daily model levels over the next `pathDays` days). */
  total?: string | string[];
  /** D3: the first day the 30-day average of a series exceeds a value. */
  threshold?: { id: string; value: number };
}

// ---------------------------------------------------------------------------------------------------------- helpers
const EPS = 1e-6;
const clip = (x: number): number => Math.min(1 - EPS, Math.max(EPS, x));
export const fwd = (tr: Transform, x: number): number =>
  tr === "log1p"
    ? Math.log1p(x)
    : tr === "log"
      ? Math.log(Math.max(x, EPS))
      : Math.log(clip(x) / (1 - clip(x)));
export const inv = (tr: Transform, y: number): number =>
  tr === "log1p" ? Math.expm1(y) : tr === "log" ? Math.exp(y) : 1 / (1 + Math.exp(-y));
export const round = (x: number, d = 6): number => {
  const v = Number(x.toFixed(d));
  return Object.is(v, -0) ? 0 : v;
};
const dayMs = 86_400_000;
export const addDays = (d: string, n: number): string =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * dayMs).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / dayMs);

/** Calendar months later, same day of month (clamped to the month end). */
export function addMonths(d: string, k: number): string {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + k, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(dd, last)))
    .toISOString()
    .slice(0, 10);
}

/** Type-7 quantile of an array (sorted copy). */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) throw new Error("quantile of nothing");
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (hash: string, label: string): number =>
  parseInt(createHash("sha256").update(`${hash}|${label}`).digest("hex").slice(0, 8), 16);

/** Mean of the observed values in [i - win + 1, i]; null when fewer than `min` are observed. */
export function trailingMean(
  values: readonly (number | null)[],
  i: number,
  win: number,
  min: number,
): number | null {
  let s = 0;
  let c = 0;
  for (let k = Math.max(0, i - win + 1); k <= i; k++) {
    const v = values[k];
    if (v !== null && v !== undefined) {
      s += v;
      c++;
    }
  }
  return c >= min ? s / c : null;
}
/** y[t] = f(7-day mean). */
export function toY(
  s: Pick<SeriesInput, "values" | "transform">,
  cfg: Pick<ForecastConfig, "m7Min">,
): (number | null)[] {
  return s.values.map((_, i) => {
    const m = trailingMean(s.values, i, 7, cfg.m7Min);
    return m === null ? null : fwd(s.transform, m);
  });
}
/** Trailing 30-day average of the observed days (history line of the charts); null where nothing is observed. */
export function trailingAverage(values: readonly (number | null)[], win = 30): (number | null)[] {
  return values.map((_, i) => trailingMean(values, i, win, 1));
}

// ---------------------------------------------------------------------------------------------------------- models
function lastDefined(y: readonly (number | null)[], T: number): number {
  for (let i = T; i >= 0; i--) if (y[i] !== null && y[i] !== undefined) return i;
  throw new Error("series has no observation up to the origin");
}
function windowPoints(y: readonly (number | null)[], T: number, trailing: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, T - trailing + 1); i <= T; i++)
    if (y[i] !== null && y[i] !== undefined) out.push(i);
  return out;
}
const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BETAS = [0.05, 0.1, 0.2, 0.3, 0.5];

/** Damped Holt in error-correction form: l = l' + a e, b = phi b' + a B e, with l' = l + phi b. Returns state at T and SSE. */
function holtRun(y: readonly (number | null)[], pts: number[], T: number, a: number, B: number, phi: number) {
  const i0 = pts[0]!;
  let l = y[i0] as number;
  let b = 0;
  let sse = 0;
  for (let i = i0 + 1; i <= T; i++) {
    const pred = l + phi * b;
    const v = y[i];
    if (v !== null && v !== undefined) {
      const e = v - pred;
      sse += e * e;
      l = pred + a * e;
      b = phi * b + a * B * e;
    } else {
      l = pred;
      b = phi * b;
    }
  }
  return { l, b, sse };
}
export function fitDamped(
  y: readonly (number | null)[],
  T: number,
  cfg: Pick<ForecastConfig, "trailing" | "phi">,
) {
  const pts = windowPoints(y, T, cfg.trailing);
  if (pts.length < 3) return { alpha: 0.5, beta: 0.1, l: y[lastDefined(y, T)] as number, b: 0 };
  let best = { alpha: ALPHAS[0]!, beta: BETAS[0]!, sse: Infinity, l: 0, b: 0 };
  for (const a of ALPHAS)
    for (const B of BETAS) {
      const r = holtRun(y, pts, T, a, B, cfg.phi);
      if (r.sse < best.sse) best = { alpha: a, beta: B, ...r };
    }
  return { alpha: best.alpha, beta: best.beta, l: best.l, b: best.b };
}

/** Forecast of y for h = 1..H from the observations up to index T (nothing after T is read). */
export function forecastLog(
  model: ModelId,
  y: readonly (number | null)[],
  T: number,
  H: number,
  cfg: Pick<ForecastConfig, "trailing" | "phi">,
): number[] {
  const last = lastDefined(y, T);
  const yl = y[last] as number;
  const hs = Array.from({ length: H }, (_, k) => k + 1);
  if (model === "naive") return hs.map(() => yl);
  if (model === "median") {
    const a = forecastLog("drift", y, T, H, cfg);
    const b = forecastLog("trend", y, T, H, cfg);
    const c = forecastLog("damped", y, T, H, cfg);
    return hs.map((_, k) => [a[k]!, b[k]!, c[k]!].sort((p, q) => p - q)[1]!);
  }
  const pts = windowPoints(y, T, cfg.trailing);
  if (model === "drift") {
    const i0 = pts[0]!;
    const i1 = pts[pts.length - 1]!;
    const slope = i1 > i0 ? ((y[i1] as number) - (y[i0] as number)) / (i1 - i0) : 0;
    return hs.map((h) => (y[i1] as number) + slope * (T + h - i1));
  }
  if (model === "trend") {
    if (pts.length < 2) return hs.map(() => yl);
    const xs = pts.map((i) => i - T);
    const ys = pts.map((i) => y[i] as number);
    const mx = mean(xs);
    const my = mean(ys);
    let sxx = 0;
    let sxy = 0;
    xs.forEach((x, k) => {
      sxx += (x - mx) * (x - mx);
      sxy += (x - mx) * (ys[k]! - my);
    });
    const slope = sxx > 0 ? sxy / sxx : 0;
    const at0 = my - slope * mx; // fitted value at T
    return hs.map((h) => at0 + slope * h);
  }
  // damped
  const f = fitDamped(y, T, cfg);
  let acc = 0;
  let pw = 1;
  return hs.map(() => {
    pw *= cfg.phi;
    acc += pw;
    return f.l + f.b * acc;
  });
}

// ---------------------------------------------------------------------------------------------------------- backtest
export interface OriginRecord {
  index: number;
  date: string;
  horizons: Record<string, { actual: number } & Record<ModelId, number>>;
}
interface ErrRow {
  origin: number;
  e: number;
}

function avgObserved(
  values: readonly (number | null)[],
  end: number,
  win: number,
  minObs: number,
): number | null {
  const m = trailingMean(values, end, win, minObs);
  return m;
}

function backtest(s: SeriesInput, y: (number | null)[], cfg: ForecastConfig) {
  const n = s.days.length;
  const origins: OriginRecord[] = [];
  const errs: Record<ModelId, Record<number, ErrRow[]>> = Object.fromEntries(
    MODEL_ORDER.map((m) => [m, Object.fromEntries(cfg.horizons.map((h) => [h, [] as ErrRow[]]))]),
  ) as never;
  const maxH = Math.max(...cfg.horizons);
  for (let T = cfg.firstOrigin; T < n; T += cfg.originStep) {
    if (lastDefinedSafe(y, T) < 0) continue;
    const fc: Partial<Record<ModelId, number[]>> = {};
    const rec: OriginRecord = { index: T, date: s.days[T]!, horizons: {} };
    for (const h of cfg.horizons) {
      if (T + h > n - 1) continue;
      const A = avgObserved(s.values, T + h, cfg.avgWindow, cfg.minObs);
      if (A === null) continue;
      const row = { actual: round(A) } as { actual: number } & Record<ModelId, number>;
      for (const m of MODEL_ORDER) {
        const path = (fc[m] ??= forecastLog(m, y, T, maxH, cfg));
        const levels = path.slice(h - cfg.avgWindow, h).map((v) => inv(s.transform, v));
        const Ahat = mean(levels);
        row[m] = round(Ahat);
        errs[m][h]!.push({
          origin: T,
          e: fwd(s.transform, A) - fwd(s.transform, Ahat),
        });
      }
      rec.horizons[String(h)] = row;
    }
    if (Object.keys(rec.horizons).length) origins.push(rec);
  }
  return { origins, errs };
}
function lastDefinedSafe(y: readonly (number | null)[], T: number): number {
  for (let i = T; i >= 0; i--) if (y[i] !== null && y[i] !== undefined) return i;
  return -1;
}

// ---------------------------------------------------------------------------------------------------------- bands
function halfWidths(abs: number[], cfg: ForecastConfig) {
  return { w50: quantile(abs, cfg.band.inner), w80: quantile(abs, cfg.band.outer) };
}
/** Half-width in f-space at horizon h (non-decreasing in h), given the anchors at the scored horizons. */
export function widthCurve(anchors: { h: number; w: number }[], H: number): number[] {
  const out: number[] = [];
  let run = 0;
  for (let h = 1; h <= H; h++) {
    let w: number;
    const first = anchors[0]!;
    const lastA = anchors[anchors.length - 1]!;
    if (h <= first.h) w = first.w * Math.sqrt(h / first.h);
    else if (h >= lastA.h) w = lastA.w * Math.sqrt(h / lastA.h);
    else {
      let k = 0;
      while (anchors[k + 1]!.h < h) k++;
      const a = anchors[k]!;
      const b = anchors[k + 1]!;
      w = a.w + ((b.w - a.w) * (h - a.h)) / (b.h - a.h);
    }
    run = Math.max(run, w);
    out.push(run);
  }
  return out;
}

/** Time-ordered check without leakage: the width for origin i uses only origins j whose target was known at origin i (T_j + h <= T_i); at least `minPrior` of them are needed. */
function forwardCoverage(errs: ErrRow[], q: number, h: number, minPrior = 4): { hits: number; n: number } {
  let hits = 0;
  let n = 0;
  for (const cur of errs) {
    const prior = errs.filter((r) => r.origin + h <= cur.origin).map((r) => Math.abs(r.e));
    if (prior.length < minPrior) continue;
    n++;
    if (Math.abs(cur.e) <= quantile(prior, q) + 1e-12) hits++;
  }
  return { hits, n };
}

function coverage(errs: ErrRow[], q: number): { inSample: number; leaveOneOut: number | null; n: number } {
  const abs = errs.map((r) => Math.abs(r.e));
  const w = quantile(abs, q);
  const inS = abs.filter((a) => a <= w + 1e-12).length / abs.length;
  if (abs.length < 3) return { inSample: inS, leaveOneOut: null, n: abs.length };
  let hit = 0;
  abs.forEach((a, i) => {
    const rest = abs.filter((_, j) => j !== i);
    if (a <= quantile(rest, q) + 1e-12) hit++;
  });
  return { inSample: inS, leaveOneOut: hit / abs.length, n: abs.length };
}

// ---------------------------------------------------------------------------------------------------------- simulation
function oneStepResiduals(model: ModelId, y: (number | null)[], cfg: ForecastConfig): (number | null)[] {
  const out: (number | null)[] = y.map(() => null);
  const res: number[] = [];
  for (let t = 31; t < y.length; t++) {
    const v = y[t];
    if (v === null || v === undefined) continue;
    if (windowPoints(y, t - 1, cfg.trailing).length < 30) continue;
    const pred = forecastLog(model, y, t - 1, 1, cfg)[0]!;
    out[t] = v - pred;
    res.push(v - pred);
  }
  if (!res.length) return out;
  const mu = mean(res);
  return out.map((r) => (r === null ? null : r - mu));
}

/** Block-bootstrap index sequences shared by every series in `res` (aligned on calendar days). */
function drawPaths(res: (number | null)[][], cfg: ForecastConfig, seed: number): number[][][] | null {
  const n = res[0]!.length;
  const ok = (i: number): boolean => res.every((r) => r[i] !== null);
  const starts: number[] = [];
  for (let i = 0; i + cfg.block <= n; i++) {
    let good = true;
    for (let k = 0; k < cfg.block; k++)
      if (!ok(i + k)) {
        good = false;
        break;
      }
    if (good) starts.push(i);
  }
  if (!starts.length) return null;
  const rnd = mulberry32(seed);
  const paths: number[][][] = [];
  for (let p = 0; p < cfg.paths; p++) {
    const cum = res.map(() => new Array<number>(cfg.pathDays).fill(0));
    const run = res.map(() => 0);
    let h = 0;
    while (h < cfg.pathDays) {
      const s0 = starts[Math.floor(rnd() * starts.length)]!;
      for (let k = 0; k < cfg.block && h < cfg.pathDays; k++, h++) {
        res.forEach((r, j) => {
          run[j]! += r[s0 + k] as number;
          cum[j]![h] = run[j]!;
        });
      }
    }
    paths.push(cum);
  }
  return paths;
}

/** 30-day averages ending at T+h, h = 1..H, mixing observed history (days <= T) with future levels. */
export function averagePath(
  values: readonly (number | null)[],
  levels: readonly number[],
  win: number,
): number[] {
  const n = values.length;
  const T = n - 1;
  const H = levels.length;
  const total = n + H;
  const sum = new Array<number>(total + 1).fill(0);
  const cnt = new Array<number>(total + 1).fill(0);
  for (let i = 0; i < total; i++) {
    const hist = i < n;
    const v = hist ? values[i] : levels[i - n];
    sum[i + 1] = sum[i]! + (v === null || v === undefined ? 0 : v);
    cnt[i + 1] = cnt[i]! + (v === null || v === undefined ? 0 : 1);
  }
  const out: number[] = [];
  for (let h = 1; h <= H; h++) {
    const end = T + h;
    const lo = Math.max(0, end - win + 1);
    const c = cnt[end + 1]! - cnt[lo]!;
    out.push((sum[end + 1]! - sum[lo]!) / c);
  }
  return out;
}

/** First index (1-based horizon) where `a[h] > b[h]`; null if none. */
export function firstCrossing(a: readonly number[], b: readonly number[] | number): number | null {
  for (let h = 0; h < a.length; h++) {
    const t = typeof b === "number" ? b : b[h]!;
    if (a[h]! > t) return h + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------- main
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface SeriesResult {
  [k: string]: unknown;
}

export function buildForecast(
  input: ForecastInput,
  over: Partial<ForecastConfig> = {},
): Record<string, unknown> {
  const cfg: ForecastConfig = { ...DEFAULT_CONFIG, ...over };
  const first = input.series[0]!;
  const days = first.days;
  const n = days.length;
  const lastDay = days[n - 1]!;
  for (const s of input.series)
    if (s.days.length !== n || s.days[0] !== days[0] || s.days[n - 1] !== lastDay)
      throw new Error(`series ${s.id} is not on the common calendar`);
  const inputHash = sha(JSON.stringify([input.series.map((s) => [s.id, s.transform, s.values]), days, cfg]));
  const maxScored = Math.max(...cfg.horizons);

  const ys = new Map<string, (number | null)[]>();
  const chosen = new Map<string, ModelId>();
  const central = new Map<string, { yhat: number[]; levels: number[]; avg: number[] }>();
  const out: Record<string, unknown> = {};
  const seriesOut: Record<string, unknown> = {};

  for (const s of input.series) {
    const y = toY(s, cfg);
    ys.set(s.id, y);
    const { origins, errs } = backtest(s, y, cfg);
    const table: unknown[] = [];
    const mae: Record<string, Record<number, { mae: number; n: number } | null>> = {};
    for (const m of MODEL_ORDER) {
      mae[m] = {};
      for (const h of cfg.horizons) {
        const rows = errs[m][h]!;
        mae[m]![h] = rows.length ? { mae: mean(rows.map((r) => Math.abs(r.e))), n: rows.length } : null;
      }
    }
    for (const m of MODEL_ORDER)
      for (const h of cfg.horizons) {
        const cur = mae[m]![h];
        const nv = mae.naive![h];
        table.push({
          model: m,
          horizon: h,
          origins: cur?.n ?? 0,
          mae: cur ? round(cur.mae) : null,
          skill: cur && nv && nv.mae > 0 ? round(1 - cur.mae / nv.mae) : null,
        });
      }
    // model choice: lowest MAE at the longest scored horizon that has origins; ties -> simpler model
    const hSel = [...cfg.horizons].reverse().find((h) => mae.naive![h] !== null);
    let pick: ModelId = "naive";
    let reason = "no horizon could be scored, so the naive model is used";
    if (hSel !== undefined) {
      for (const m of MODEL_ORDER) {
        const cur = mae[m]![hSel]!;
        if (cur.mae < mae[pick]![hSel]!.mae - 1e-12) pick = m;
      }
      reason = `lowest mean absolute error at ${hSel} days over ${mae.naive![hSel]!.n} origins (ties go to the simpler model)`;
    }
    chosen.set(s.id, pick);
    const chErr = errs[pick];
    const anchors: { h: number; w: number }[] = [];
    const widths: unknown[] = [];
    const cal: unknown[] = [];
    let hitN = 0;
    let hitTot = 0;
    let fwdHit = 0;
    let fwdTot = 0;
    let inN = 0;
    let inTot = 0;
    for (const h of cfg.horizons) {
      const rows = chErr[h]!;
      if (!rows.length) continue;
      const w = halfWidths(
        rows.map((r) => Math.abs(r.e)),
        cfg,
      );
      anchors.push({ h, w: w.w80 });
      const c = coverage(rows, cfg.band.outer);
      const c50 = coverage(rows, cfg.band.inner);
      const fw = forwardCoverage(rows, cfg.band.outer, h);
      fwdHit += fw.hits;
      fwdTot += fw.n;
      widths.push({ horizon: h, origins: rows.length, halfWidth50: round(w.w50), halfWidth80: round(w.w80) });
      cal.push({
        horizon: h,
        origins: rows.length,
        inSample80: round(c.inSample),
        leaveOneOut80: c.leaveOneOut === null ? null : round(c.leaveOneOut),
        leaveOneOut50: c50.leaveOneOut === null ? null : round(c50.leaveOneOut),
        forward80: fw.n ? round(fw.hits / fw.n) : null,
        forwardTests: fw.n,
      });
      inN += Math.round(c.inSample * c.n);
      inTot += c.n;
      if (c.leaveOneOut !== null) {
        hitN += Math.round(c.leaveOneOut * c.n);
        hitTot += c.n;
      }
    }
    const anchors50: { h: number; w: number }[] = cfg.horizons
      .filter((h) => chErr[h]!.length)
      .map((h) => ({
        h,
        w: halfWidths(
          chErr[h]!.map((r) => Math.abs(r.e)),
          cfg,
        ).w50,
      }));
    const looCov = hitTot ? hitN / hitTot : null;
    const inCov = inTot ? inN / inTot : null;
    // the verdict uses the time-ordered (forward) coverage when it has at least six test points, else leave-one-out
    const fwdCov = fwdTot >= 6 ? fwdHit / fwdTot : null;
    const usedCov = fwdCov ?? looCov;
    const calibrated =
      usedCov !== null && usedCov >= cfg.calibrationRange[0] && usedCov <= cfg.calibrationRange[1];

    // central path
    const T = n - 1;
    const yhat = forecastLog(pick, y, T, cfg.pathDays, cfg);
    const levels = yhat.map((v) => inv(s.transform, v));
    const avg = averagePath(s.values, levels, cfg.avgWindow);
    central.set(s.id, { yhat, levels, avg });
    const w80 = anchors.length ? widthCurve(anchors, cfg.pathDays) : null;
    const w50 = anchors50.length ? widthCurve(anchors50, cfg.pathDays) : null;
    const band = (k: number, w: number[] | null, sign: 1 | -1): number =>
      w ? inv(s.transform, fwd(s.transform, avg[k]!) + sign * w[k]!) : avg[k]!;
    const path = {
      firstDay: addDays(lastDay, 1),
      central: avg.map((v) => round(v, 4)),
      band50Lo: avg.map((_, k) => round(band(k, w50, -1), 4)),
      band50Hi: avg.map((_, k) => round(band(k, w50, 1), 4)),
      band80Lo: avg.map((_, k) => round(band(k, w80, -1), 4)),
      band80Hi: avg.map((_, k) => round(band(k, w80, 1), 4)),
    };
    const rowAt = (h: number) => ({
      horizon: h,
      date: addDays(lastDay, h),
      central: round(avg[h - 1]!, 4),
      band50: [round(path.band50Lo[h - 1]!, 4), round(path.band50Hi[h - 1]!, 4)],
      band80: [round(path.band80Lo[h - 1]!, 4), round(path.band80Hi[h - 1]!, 4)],
      beyondBacktest: h > maxScored,
    });
    const horizonsOut = cfg.reportHorizons.map(rowAt);
    const checkpoints = cfg.checkpoints.map((d) => ({ ...rowAt(diffDays(lastDay, d)), date: d }));
    const naive90 = mae.naive![maxScored];
    const ch90 = mae[pick]![maxScored];
    const skill90 = naive90 && ch90 && naive90.mae > 0 ? 1 - ch90.mae / naive90.mae : null;
    const verdict =
      skill90 !== null && skill90 >= cfg.skillThreshold && calibrated
        ? "FORECAST_WITH_SKILL"
        : "FORECAST_LOW_SKILL";
    const obsIdx = s.values.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
    const missing = days.filter((_, i) => s.values[i] === null);
    const l30from = Math.max(0, T - cfg.avgWindow + 1);
    let l30obs = 0;
    for (let i = l30from; i <= T; i++) if (s.values[i] !== null) l30obs++;
    const last30 = trailingMean(s.values, T, cfg.avgWindow, 1);
    seriesOut[s.id] = {
      id: s.id,
      label: s.label,
      unit: s.unit,
      transform: s.transform,
      firstDay: days[0],
      lastDay,
      days: n,
      observedDays: obsIdx.length,
      missingDays: missing,
      last30: last30 === null ? null : round(last30, 4),
      last30Window: { from: days[l30from], to: lastDay, observedDays: l30obs },
      backtest: {
        origins: origins.length,
        originIndexFirst: cfg.firstOrigin,
        table,
        origins_detail: origins,
      },
      chosenModel: pick,
      chosenReason: reason,
      dampedFit: pick === "damped" || pick === "median" ? fitDamped(y, T, cfg) : null,
      skill90: skill90 === null ? null : round(skill90),
      widths,
      calibration: {
        range80: cfg.calibrationRange,
        perHorizon: cal,
        pooledLeaveOneOut80: looCov === null ? null : round(looCov),
        pooledInSample80: inCov === null ? null : round(inCov),
        pooledForward80: fwdCov === null ? null : round(fwdCov),
        forwardTests: fwdTot,
        usedForVerdict: fwdCov !== null ? "forward" : "leaveOneOut",
        calibrated,
      },
      verdict,
      horizons: horizonsOut,
      checkpoints,
      path,
    };
  }
  out.series = seriesOut;

  // ---- simulation (derived quantities) -----------------------------------------------------------------------------
  const seriesBy = new Map(input.series.map((s) => [s.id, s]));
  const resFor = (id: string) => oneStepResiduals(chosen.get(id)!, ys.get(id)!, cfg);
  const derived: Record<string, unknown> = {};
  const pct = (xs: number[], q: number): number => quantile(xs, q);
  if (input.crossover) {
    const { a, b } = input.crossover;
    const sa = seriesBy.get(a)!;
    const sb = seriesBy.get(b)!;
    const ca = central.get(a)!;
    const cb = central.get(b)!;
    const draws = drawPaths([resFor(a), resFor(b)], cfg, seedOf(inputHash, `crossover:${a}:${b}`));
    const T = n - 1;
    const aLast = trailingMean(sa.values, T, cfg.avgWindow, 1)!;
    const bLast = trailingMean(sb.values, T, cfg.avgWindow, 1)!;
    const hCentral = firstCrossing(ca.avg, cb.avg);
    const sixM = diffDays(lastDay, addMonths(lastDay, 6));
    let within6 = 0;
    let within12 = 0;
    let above6 = 0;
    let above12 = 0;
    const hs: number[] = [];
    if (draws) {
      for (const d of draws) {
        const la = d[0]!.map((c, k) => inv(sa.transform, ca.yhat[k]! + c));
        const lb = d[1]!.map((c, k) => inv(sb.transform, cb.yhat[k]! + c));
        const Aa = averagePath(sa.values, la, cfg.avgWindow);
        const Ab = averagePath(sb.values, lb, cfg.avgWindow);
        const h = firstCrossing(Aa, Ab);
        if (h !== null) {
          hs.push(h);
          if (h <= sixM) within6++;
          if (h <= cfg.pathDays) within12++;
        }
        if (Aa[sixM - 1]! > Ab[sixM - 1]!) above6++;
        if (Aa[cfg.pathDays - 1]! > Ab[cfg.pathDays - 1]!) above12++;
      }
    }
    const N = draws ? draws.length : 0;
    derived.crossover = {
      a,
      b,
      aboveAtLastDay: aLast > bLast,
      last30A: round(aLast, 4),
      last30B: round(bLast, 4),
      centralHorizon: hCentral,
      centralDate: hCentral === null ? null : addDays(lastDay, hCentral),
      paths: N,
      seed: seedOf(inputHash, `crossover:${a}:${b}`),
      block: cfg.block,
      within6Months: N ? round(within6 / N) : null,
      within12Months: N ? round(within12 / N) : null,
      aboveAt6Months: N ? round(above6 / N) : null,
      aboveAt12Months: N ? round(above12 / N) : null,
      medianHorizon: hs.length ? pct(hs, 0.5) : null,
      medianDate: hs.length ? addDays(lastDay, Math.round(pct(hs, 0.5))) : null,
      p10Date: hs.length ? addDays(lastDay, Math.round(pct(hs, 0.1))) : null,
      p90Date: hs.length ? addDays(lastDay, Math.round(pct(hs, 0.9))) : null,
      sixMonthsDate: addDays(lastDay, sixM),
      twelveMonthsDate: addDays(lastDay, cfg.pathDays),
      pathsWithCrossing: hs.length,
    };
  }
  for (const id of Array.isArray(input.total) ? input.total : input.total ? [input.total] : []) {
    const s = seriesBy.get(id)!;
    const c = central.get(id)!;
    const draws = drawPaths([resFor(id)], cfg, seedOf(inputHash, `total:${id}`));
    const totals: number[] = [];
    if (draws)
      for (const d of draws)
        totals.push(d[0]!.reduce((acc, cum, k) => acc + inv(s.transform, c.yhat[k]! + cum), 0));
    const obs = s.values.filter((v): v is number => v !== null);
    const last = s.values.slice(-365);
    const observedLast = last.filter((v): v is number => v !== null);
    derived[`${id}_12m`] = {
      id,
      centralTotal: round(
        c.levels.reduce((a, b) => a + b, 0),
        2,
      ),
      paths: totals.length,
      seed: seedOf(inputHash, `total:${id}`),
      p10: totals.length ? round(pct(totals, 0.1), 2) : null,
      p25: totals.length ? round(pct(totals, 0.25), 2) : null,
      p50: totals.length ? round(pct(totals, 0.5), 2) : null,
      p75: totals.length ? round(pct(totals, 0.75), 2) : null,
      p90: totals.length ? round(pct(totals, 0.9), 2) : null,
      observedTotalLast365: round(
        observedLast.reduce((a, b) => a + b, 0),
        2,
      ),
      observedDaysLast365: observedLast.length,
      missingDaysLast365: last.length - observedLast.length,
      observedTotalAll: round(
        obs.reduce((a, b) => a + b, 0),
        2,
      ),
      note: "Sum of the daily model levels (7-day-mean scale) over the next 365 days; days missing from the history are not filled.",
    };
  }
  if (input.threshold) {
    const { id, value } = input.threshold;
    const s = seriesBy.get(id)!;
    const c = central.get(id)!;
    const draws = drawPaths([resFor(id)], cfg, seedOf(inputHash, `threshold:${id}`));
    const hCentral = firstCrossing(c.avg, value);
    const sixM = diffDays(lastDay, addMonths(lastDay, 6));
    let w6 = 0;
    let w12 = 0;
    const hs: number[] = [];
    if (draws)
      for (const d of draws) {
        const l = d[0]!.map((cum, k) => inv(s.transform, c.yhat[k]! + cum));
        const A = averagePath(s.values, l, cfg.avgWindow);
        const h = firstCrossing(A, value);
        if (h !== null) {
          hs.push(h);
          if (h <= sixM) w6++;
          if (h <= cfg.pathDays) w12++;
        }
      }
    const N = draws ? draws.length : 0;
    const T = n - 1;
    derived[`${id}_threshold`] = {
      id,
      value,
      last30: round(trailingMean(s.values, T, cfg.avgWindow, 1)!, 4),
      aboveAtLastDay: (trailingMean(s.values, T, cfg.avgWindow, 1) as number) > value,
      centralHorizon: hCentral,
      centralDate: hCentral === null ? null : addDays(lastDay, hCentral),
      paths: N,
      seed: seedOf(inputHash, `threshold:${id}`),
      within6Months: N ? round(w6 / N) : null,
      within12Months: N ? round(w12 / N) : null,
      medianDate: hs.length ? addDays(lastDay, Math.round(pct(hs, 0.5))) : null,
      pathsWithCrossing: hs.length,
    };
  }
  out.derived = derived;
  return {
    schema: "nearesis.thesis.forecast.v1",
    method: {
      transformByKind: {
        log1p: "ln(1 + x) of the 7-day mean (amounts and counts)",
        logit: "logit of the 7-day mean (shares)",
        log: "ln(x) of the 7-day mean (ratios such as the take rate)",
      },
      models: [...MODEL_ORDER],
      config: cfg,
      description:
        "Five candidate models on the transformed 7-day mean; rolling-origin backtest; model by lowest error at the longest scored horizon; empirical bands widened with the square root of the horizon beyond it; block-bootstrap simulation of one-step residuals.",
    },
    inputHash,
    firstDay: days[0],
    lastDay,
    days: n,
    ...out,
  };
}

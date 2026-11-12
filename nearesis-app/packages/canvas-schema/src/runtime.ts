import { type ChartData, type PanelSpec, type ResultTruncation, Selection } from "@nearesis/contracts";

/** ch.26 panel state machine. ERROR may be entered from any active state and keeps last good data. */
export type PanelState =
  "DRAFT" | "VALIDATING" | "QUERYING" | "READY" | "STALE" | "REFRESHING" | "ERROR" | "ARCHIVED";

export const PANEL_TRANSITIONS: Readonly<Record<PanelState, readonly PanelState[]>> = {
  DRAFT: ["VALIDATING", "ERROR", "ARCHIVED"],
  VALIDATING: ["QUERYING", "ERROR", "ARCHIVED"],
  QUERYING: ["READY", "ERROR", "ARCHIVED"],
  READY: ["STALE", "REFRESHING", "VALIDATING", "ERROR", "ARCHIVED"],
  STALE: ["REFRESHING", "ERROR", "ARCHIVED"],
  REFRESHING: ["READY", "STALE", "ERROR", "ARCHIVED"],
  ERROR: ["VALIDATING", "REFRESHING", "ARCHIVED"],
  ARCHIVED: [],
};

export function canTransition(from: PanelState, to: PanelState): boolean {
  return PANEL_TRANSITIONS[from].includes(to);
}

export interface PanelRuntime {
  state: PanelState;
  /** Last data that reached READY; kept through STALE/REFRESHING/ERROR (C18b, C14c). */
  lastGood: ChartData | null;
  error: { code: string; message: string } | null;
  history: PanelState[];
}

export function initialRuntime(): PanelRuntime {
  return { state: "DRAFT", lastGood: null, error: null, history: ["DRAFT"] };
}

export class IllegalTransition extends Error {
  constructor(
    readonly from: PanelState,
    readonly to: PanelState,
  ) {
    super(`illegal panel transition ${from} -> ${to}`);
  }
}

export function transition(
  rt: PanelRuntime,
  to: PanelState,
  payload: { data?: ChartData; error?: { code: string; message: string } } = {},
): PanelRuntime {
  if (!canTransition(rt.state, to)) throw new IllegalTransition(rt.state, to);
  return {
    state: to,
    lastGood: to === "READY" && payload.data ? payload.data : rt.lastGood,
    error: to === "ERROR" ? (payload.error ?? { code: "UNKNOWN", message: "unknown error" }) : null,
    history: [...rt.history, to],
  };
}

/**
 * Min/max bucket downsampling: per bucket keeps the first, min, max and last points, so spikes survive (C18d).
 * Input points must be sorted by x. Points whose y is null are gaps and are kept as gap markers (no interpolation).
 */
export function downsampleMinMax(
  points: ReadonlyArray<readonly [number, number | null]>,
  targetBuckets: number,
): { method: "none" | "min_max_bucket"; points: Array<[number, number | null]> } {
  if (points.length <= targetBuckets * 4) return { method: "none", points: points.map((p) => [p[0], p[1]]) };
  const size = Math.ceil(points.length / targetBuckets);
  const out: Array<[number, number | null]> = [];
  for (let start = 0; start < points.length; start += size) {
    const end = Math.min(points.length, start + size);
    let minI = -1;
    let maxI = -1;
    let gapI = -1;
    for (let i = start; i < end; i++) {
      const y = points[i]![1];
      if (y === null) {
        if (gapI < 0) gapI = i;
        continue;
      }
      if (minI < 0 || y < points[minI]![1]!) minI = i;
      if (maxI < 0 || y > points[maxI]![1]!) maxI = i;
    }
    const keep = new Set<number>([start, end - 1]);
    if (minI >= 0) keep.add(minI);
    if (maxI >= 0) keep.add(maxI);
    if (gapI >= 0) keep.add(gapI);
    for (const i of [...keep].sort((a, b) => a - b)) out.push([points[i]![0], points[i]![1]]);
  }
  return { method: "min_max_bucket", points: out };
}

/** Default per-chart row bound (ch.13 Backpressure "per-chart max rows/points"). Mirrors the gateway's 10,000-row limit. */
export const DEFAULT_MAX_CHART_ROWS = 10_000;

export interface BoundedRows<T> {
  rows: T[];
  downsampling: ChartData["downsampling"];
  /** Present only when rows were cut; absent means the result is complete. The UI must show it as a label. */
  truncation?: ResultTruncation;
}

/**
 * The max-rows rule for chart data. `count` rows are produced lazily by `rowAt` (so a 5-million-row source is never held
 * in memory). Within `maxRows` nothing changes. Beyond it: a time series (`yAt` given: y of row i, null for a gap) is
 * min/max-bucket downsampled so spikes and gaps survive and the result is at most `maxRows` rows; any other result is
 * truncated to its first `maxRows` rows. Both carry explicit `truncation` metadata with the original size.
 */
export function boundChartRows<T>(args: {
  count: number;
  rowAt: (i: number) => T;
  yAt?: (i: number) => number | null;
  maxRows?: number;
}): BoundedRows<T> {
  const maxRows = Math.max(4, Math.floor(args.maxRows ?? DEFAULT_MAX_CHART_ROWS));
  const n = args.count;
  if (n <= maxRows) {
    const rows: T[] = [];
    for (let i = 0; i < n; i++) rows.push(args.rowAt(i));
    return { rows, downsampling: { method: "none", originalPoints: n } };
  }
  const trunc = (method: ResultTruncation["method"], returned: number): ResultTruncation => ({
    truncated: true,
    reason: "MAX_ROWS",
    method,
    requestedRows: n,
    returnedRows: returned,
    maxRows,
  });
  if (!args.yAt) {
    const rows: T[] = [];
    for (let i = 0; i < maxRows; i++) rows.push(args.rowAt(i));
    return {
      rows,
      downsampling: { method: "none", originalPoints: n },
      truncation: trunc("truncate", rows.length),
    };
  }
  // Each bucket keeps its first, last, min, max and first gap: at most 5 rows, so size buckets for the bound.
  const buckets = Math.max(1, Math.floor(maxRows / 5));
  const size = Math.ceil(n / buckets);
  const keep: number[] = [];
  for (let start = 0; start < n; start += size) {
    const end = Math.min(n, start + size);
    let minI = -1;
    let maxI = -1;
    let gapI = -1;
    let minV = 0;
    let maxV = 0;
    for (let i = start; i < end; i++) {
      const y = args.yAt(i);
      if (y === null) {
        if (gapI < 0) gapI = i;
        continue;
      }
      if (minI < 0 || y < minV) {
        minI = i;
        minV = y;
      }
      if (maxI < 0 || y > maxV) {
        maxI = i;
        maxV = y;
      }
    }
    const idx = new Set<number>([start, end - 1]);
    if (minI >= 0) idx.add(minI);
    if (maxI >= 0) idx.add(maxI);
    if (gapI >= 0) idx.add(gapI);
    for (const i of [...idx].sort((a, b) => a - b)) keep.push(i);
  }
  const rows = keep.map((i) => args.rowAt(i));
  return {
    rows,
    downsampling: { method: "min_max_bucket", originalPoints: n },
    truncation: trunc("min_max_bucket", rows.length),
  };
}

/** Builds the C13 selection context from a panel, its current data and a UTC interval. Never pixel-based. */
export function buildSelection(args: {
  panel: PanelSpec;
  data: ChartData;
  start: string;
  end: string;
  rendererVersion: string;
}): Selection {
  const { panel, data } = args;
  const xName = panel.encoding.x;
  const xi = data.columns.findIndex((c) => c.name === xName);
  const from = Date.parse(args.start);
  const to = Date.parse(args.end);
  const seriesIds = panel.encoding.y ?? [];
  const dataPointIds: string[] = [];
  data.rows.forEach((row) => {
    const xv = xi >= 0 ? row[xi] : null;
    const t = typeof xv === "string" ? Date.parse(xv) : typeof xv === "number" ? xv : NaN;
    if (Number.isFinite(t) && t >= from && t <= to)
      for (const s of seriesIds) dataPointIds.push(`${s}@${new Date(t).toISOString()}`);
  });
  const units: Record<string, string> = {};
  for (const s of seriesIds) units[s] = panel.dataBinding.units[s] ?? "unknown";
  return Selection.parse({
    panelId: panel.panelId,
    queryHash: panel.queryRef.hash,
    semanticVersion: panel.queryRef.semanticVersion,
    interval: { start: new Date(from).toISOString(), end: new Date(to).toISOString() },
    seriesIds,
    dataPointIds: dataPointIds.slice(0, 10000),
    units,
    sourceWatermark: data.sourceWatermark,
    rendererVersion: args.rendererVersion,
  });
}

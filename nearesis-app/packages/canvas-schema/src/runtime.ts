import { type ChartData, type PanelSpec, Selection } from "@nearesis/contracts";

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

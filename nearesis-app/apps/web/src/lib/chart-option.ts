/**
 * Adapter: (PanelSpec, VizIR, ChartData, markers) -> the design system's declared ChartSpec. It is pure data built only
 * from validated specs; no function, formatter or HTML can pass through. The ui `Chart` turns the spec into an ECharts
 * option with token colours. Large time series are reduced to min/max buckets here so the footer label and the
 * rendered point count stay identical to what is drawn (C18).
 */
import type { ChartData, MarkerSpec, PanelSpec } from "@nearesis/contracts";
import { downsampleMinMax, type VizIR } from "@nearesis/canvas-schema";
import type { ChartKind, ChartMarker, ChartSpec } from "@nearesis/ui";

export const RENDERER_VERSION = "echarts-6.1.0/adapter-1";
const DOWNSAMPLE_THRESHOLD = 8000;
const DOWNSAMPLE_BUCKETS = 2000;

export function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = Number(v); // display only; exact strings stay in tables and the provenance inspector
  return Number.isFinite(n) ? n : null;
}

function toTime(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export interface BuiltChart {
  spec: ChartSpec;
  downsampling: { method: "none" | "min_max_bucket"; originalPoints: number; renderedPoints: number };
}

function markerToSpec(m: MarkerSpec): ChartMarker {
  if (m.anchor.kind === "time_range")
    return { id: m.markerId, kind: "time_range", start: m.anchor.start, end: m.anchor.end, label: "marker" };
  if (m.anchor.kind === "source_event")
    return { id: m.markerId, kind: "time_point", at: m.anchor.at, label: `event ${m.anchor.sourceId}` };
  if (m.anchor.kind === "time_point")
    return { id: m.markerId, kind: "time_point", at: m.anchor.at, label: "marker" };
  return {
    id: m.markerId,
    kind: "threshold",
    value: m.anchor.value,
    op: m.anchor.op,
    label: `${m.anchor.op} ${m.anchor.value}`,
  };
}

export function toChartSpec(args: {
  panel: PanelSpec;
  viz: VizIR;
  data: ChartData;
  gaps: Array<{ from: string; to: string; reason: string }>;
  markers: MarkerSpec[];
}): BuiltChart {
  const { panel, viz, data } = args;
  const col = (name: string | undefined) => (name ? data.columns.findIndex((c) => c.name === name) : -1);
  const xi = col(panel.encoding.x);
  const yFields = panel.encoding.y ?? [];
  const isTime = viz.x?.type === "utc_time";
  const original = data.rows.length;
  let rows = data.rows;
  let method: "none" | "min_max_bucket" = "none";

  // Candlesticks are row-wise OHLC records and heatmaps are cell grids: dropping rows would change what is shown.
  const rowWise = panel.kind === "candlestick" || panel.kind === "heatmap";
  if (isTime && panel.kind !== "scatter" && !rowWise && rows.length > DOWNSAMPLE_THRESHOLD) {
    const keep = new Set<number>();
    for (const f of yFields) {
      const yi = col(f);
      const pts: Array<[number, number | null]> = rows.map((r) => [
        toTime(r[xi] as string | number | null) ?? 0,
        toNumber(r[yi] as string | number | null),
      ]);
      const d = downsampleMinMax(pts, DOWNSAMPLE_BUCKETS);
      if (d.method === "min_max_bucket") method = d.method;
      for (const p of d.points) keep.add(p[0]);
    }
    if (method === "min_max_bucket")
      rows = rows.filter((r) => keep.has(toTime(r[xi] as string | number | null) ?? 0));
  }

  const kind: ChartKind =
    panel.kind === "scatter"
      ? "scatter"
      : panel.kind === "candlestick"
        ? "candlestick"
        : panel.kind === "heatmap"
          ? "heatmap"
          : panel.kind === "bar" || panel.kind === "waterfall"
            ? "bar"
            : viz.mark === "area"
              ? "area"
              : "line";
  const xType: "time" | "category" | "value" =
    panel.kind === "heatmap"
      ? "category"
      : isTime
        ? "time"
        : panel.kind === "scatter" || viz.x?.type === "number"
          ? "value"
          : "category";

  const spec: ChartSpec = {
    kind,
    title: panel.title,
    columns: data.columns.map((c) => ({ name: c.name, unit: c.unit })),
    rows,
    x: { field: panel.encoding.x ?? "", type: xType },
    y: (panel.kind === "heatmap" ? [panel.encoding.series ?? ""] : yFields).map((f) => {
      const axis = viz.axes.find((a) => a.field === f);
      const side = axis?.side === "right" ? ("right" as const) : ("left" as const);
      const unit = panel.dataBinding.units[f] ?? data.columns[col(f)]?.unit ?? null;
      return { field: f, unit: unit ?? (side === "right" ? f : null), side };
    }),
    ...(panel.kind === "heatmap" && yFields[0]
      ? {
          value: {
            field: yFields[0],
            unit: panel.dataBinding.units[yFields[0]] ?? data.columns[col(yFields[0])]?.unit ?? null,
          },
        }
      : {}),
    scale: viz.scale,
    gaps: args.gaps,
    markers: args.markers.map(markerToSpec),
    downsampling: { method, originalPoints: original },
  };
  return {
    spec,
    downsampling: { method, originalPoints: original, renderedPoints: rows.length * yFields.length },
  };
}

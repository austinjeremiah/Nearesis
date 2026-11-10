/**
 * Renderer adapter: (PanelSpec, VizIR, ChartData, markers) -> ECharts option. Pure data, built only from validated
 * specs. It never copies a spec- or data-supplied function/formatter (none can exist after validation) and uses the
 * canvas renderer with rich-text tooltips, so labels, series names and category values are drawn as text, never HTML.
 */
import type { ChartData, MarkerSpec, PanelSpec } from "@nearesis/contracts";
import { downsampleMinMax, type VizIR } from "@nearesis/canvas-schema";

export const RENDERER_VERSION = "echarts-6.1.0/adapter-1";
const DOWNSAMPLE_THRESHOLD = 8000;
const DOWNSAMPLE_BUCKETS = 2000;

export type EChartsOption = Record<string, unknown>;

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

export interface BuiltOption {
  option: EChartsOption;
  downsampling: { method: "none" | "min_max_bucket"; originalPoints: number; renderedPoints: number };
}

export function buildChartOption(args: {
  panel: PanelSpec;
  viz: VizIR;
  data: ChartData;
  gaps: Array<{ from: string; to: string; reason: string }>;
  markers: MarkerSpec[];
  palette: { fg: string; muted: string; grid: string; series: string[]; gap: string; marker: string };
}): BuiltOption {
  const { panel, viz, data, palette } = args;
  const col = (name: string | undefined) => (name ? data.columns.findIndex((c) => c.name === name) : -1);
  const xi = col(panel.encoding.x);
  const yFields = panel.encoding.y ?? [];
  const isTime = viz.x?.type === "utc_time";
  const original = data.rows.length;
  let rendered = 0;
  let method: "none" | "min_max_bucket" = "none";

  const axisCommon = {
    axisLine: { lineStyle: { color: palette.muted } },
    axisLabel: { color: palette.muted, hideOverlap: true },
    splitLine: { lineStyle: { color: palette.grid } },
    nameTextStyle: { color: palette.muted },
  };
  const rightUnit = viz.axes.find((a) => a.side === "right")?.unit;
  const leftUnit = viz.axes.find((a) => a.side === "left")?.unit;
  const yAxisType = viz.scale === "log" ? "log" : "value";
  const yAxis: Array<Record<string, unknown>> = [
    { type: yAxisType, name: leftUnit ?? "", ...axisCommon, scale: true },
  ];
  if (rightUnit)
    yAxis.push({ type: yAxisType, name: rightUnit, ...axisCommon, scale: true, splitLine: { show: false } });

  const series: Array<Record<string, unknown>> = [];
  yFields.forEach((f, si) => {
    const yi = col(f);
    const axis = viz.axes.find((a) => a.field === f);
    const color = palette.series[si % palette.series.length];
    let pts: Array<[number | string, number | null]> = data.rows.map((r) => [
      isTime ? (toTime(r[xi]) ?? 0) : String(r[xi] ?? ""),
      toNumber(r[yi] as string | number | null),
    ]);
    if (viz.scale === "index_100") {
      const first = pts.find((p) => p[1] !== null && p[1] !== 0)?.[1] ?? null;
      pts = pts.map(([x, y]) => [x, y === null || first === null ? null : (y / first) * 100]);
    }
    if (isTime && panel.kind !== "scatter" && pts.length > DOWNSAMPLE_THRESHOLD) {
      const d = downsampleMinMax(pts as Array<[number, number | null]>, DOWNSAMPLE_BUCKETS);
      method = d.method;
      pts = d.points;
    }
    rendered += pts.length;
    const base = {
      name: f,
      yAxisIndex: axis?.side === "right" ? 1 : 0,
      data: isTime || panel.kind === "scatter" ? pts : pts.map((p) => p[1]),
      animation: false,
      itemStyle: { color },
      lineStyle: { color, width: 1.5 },
      emphasis: { disabled: pts.length > 5000 },
    };
    if (panel.kind === "scatter")
      series.push({ ...base, type: "scatter", symbolSize: 2, large: true, largeThreshold: 2000 });
    else if (panel.kind === "bar" || panel.kind === "waterfall")
      series.push({ ...base, type: "bar", barMaxWidth: 28 });
    else
      series.push({
        ...base,
        type: "line",
        showSymbol: pts.length <= 120,
        symbolSize: 4,
        connectNulls: false, // gaps render as breaks; never interpolated (C17)
        sampling: undefined,
      });
  });

  // Missingness shading for declared gaps, and markers anchored in data space (C12).
  const first = series[0];
  if (first && isTime) {
    const areas: unknown[] = args.gaps.map((g) => [
      { xAxis: Date.parse(g.from), name: `missing: ${g.reason}`, itemStyle: { color: palette.gap } },
      { xAxis: Date.parse(g.to) },
    ]);
    const lines: unknown[] = [];
    for (const m of args.markers) {
      if (m.anchor.kind === "time_range")
        areas.push([
          {
            xAxis: Date.parse(m.anchor.start),
            name: "marker",
            itemStyle: { color: palette.marker, opacity: 0.15 },
          },
          { xAxis: Date.parse(m.anchor.end) },
        ]);
      else if (m.anchor.kind === "time_point") lines.push({ xAxis: Date.parse(m.anchor.at), name: "marker" });
      else lines.push({ yAxis: m.anchor.value, name: `${m.anchor.op} ${m.anchor.value}` });
    }
    first.markArea = { silent: true, label: { color: palette.muted, fontSize: 10 }, data: areas };
    first.markLine = {
      silent: true,
      symbol: "none",
      lineStyle: { color: palette.marker, type: "dashed" },
      label: { color: palette.marker },
      data: lines,
    };
  }

  const option: EChartsOption = {
    animation: original < 2000,
    backgroundColor: "transparent",
    textStyle: { color: palette.fg },
    grid: { left: 56, right: rightUnit ? 56 : 16, top: 28, bottom: 40, containLabel: false },
    legend: yFields.length > 1 ? { top: 0, textStyle: { color: palette.muted } } : undefined,
    tooltip: {
      trigger: panel.kind === "scatter" ? "item" : "axis",
      renderMode: "richText", // drawn on canvas: label text cannot become markup
      confine: true,
    },
    xAxis: {
      type: isTime ? "time" : panel.kind === "scatter" ? "value" : "category",
      name: isTime ? "UTC" : (viz.x?.field ?? ""),
      ...axisCommon,
      ...(isTime || panel.kind === "scatter" ? {} : { data: data.rows.map((r) => String(r[xi] ?? "")) }),
      splitLine: { show: false },
    },
    yAxis,
    series,
    brush: isTime
      ? {
          xAxisIndex: 0,
          brushMode: "single",
          throttleType: "debounce",
          throttleDelay: 150,
          transformable: false,
        }
      : undefined,
    toolbox: { show: false },
    // Wheel zoom and drag pan on time axes; view changes never touch documentRevision or dataRevision.
    dataZoom: isTime ? [{ type: "inside", xAxisIndex: 0, filterMode: "none", throttle: 50 }] : undefined,
  };
  return { option, downsampling: { method, originalPoints: original, renderedPoints: rendered } };
}

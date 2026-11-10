import type { ChartMarker, ChartSpec } from "../types";
import { CHART_STYLE, type ChartTheme } from "./theme";

export type EChartsOption = Record<string, unknown>;

export interface BuildOptions {
  theme: ChartTheme;
  reducedMotion: boolean;
  /** Time axes only: enables the drag-to-select brush (data-space range, never pixels). */
  brush?: boolean;
}

export interface BuiltChart {
  option: EChartsOption;
  points: number;
}

const ANIMATE_BELOW_POINTS = 2000;

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function time(v: string | number | null | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Pure mapping: declared ChartSpec + tokens -> ECharts option object. The output is plain data: it never contains a
 * function, formatter string, HTML or a value copied from the spec into a code path. Labels come out as canvas text
 * (tooltip renderMode richText), so spec text cannot become markup.
 */
export function buildOption(spec: ChartSpec, o: BuildOptions): BuiltChart {
  const { theme: t } = o;
  const col = (name: string | undefined) => (name ? spec.columns.findIndex((c) => c.name === name) : -1);
  const isTime = spec.x.type === "time";
  const xi = col(spec.x.field);
  const points = spec.rows.length;
  const animate = !o.reducedMotion && points < ANIMATE_BELOW_POINTS;
  const text = { color: t.muted, fontSize: 11, fontFamily: t.fontFamily };

  const axisBase = {
    axisLine: { lineStyle: { color: t.border } },
    axisTick: { show: false },
    axisLabel: { ...text, hideOverlap: true, margin: 10 },
    nameTextStyle: text,
  };
  const rightUnit = spec.y.find((a) => a.side === "right")?.unit ?? undefined;
  const yType = spec.scale === "log" ? "log" : "value";
  const yAxis: Array<Record<string, unknown>> = [
    {
      type: yType,
      scale: true,
      ...axisBase,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: t.grid } },
    },
  ];
  if (rightUnit)
    yAxis.push({
      type: yType,
      scale: true,
      ...axisBase,
      axisLine: { show: false },
      splitLine: { show: false },
    });

  const series: Array<Record<string, unknown>> = [];
  const style = CHART_STYLE[spec.kind];

  if (spec.kind === "candlestick") {
    series.push({
      type: "candlestick",
      name: spec.title,
      data: spec.rows.map((r) => [time(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4])]),
      itemStyle: { color: t.up, color0: t.down, borderColor: t.up, borderColor0: t.down },
      animation: animate,
    });
  } else if (spec.kind === "heatmap") {
    const yCats = Array.from(new Set(spec.rows.map((r) => String(r[1] ?? ""))));
    const xCats = Array.from(new Set(spec.rows.map((r) => String(r[0] ?? ""))));
    const vals = spec.rows.map((r) => num(r[2])).filter((v): v is number => v !== null);
    series.push({
      type: "heatmap",
      name: spec.title,
      data: spec.rows.map((r) => [
        xCats.indexOf(String(r[0] ?? "")),
        yCats.indexOf(String(r[1] ?? "")),
        num(r[2]),
      ]),
      itemStyle: { borderColor: t.surface, borderWidth: 1, borderRadius: 2 },
      animation: animate,
    });
    return {
      points,
      option: {
        animation: animate,
        backgroundColor: "transparent",
        textStyle: text,
        grid: { left: 56, right: 16, top: 12, bottom: 56 },
        tooltip: tooltip(t),
        xAxis: { type: "category", data: xCats, ...axisBase, splitArea: { show: false } },
        yAxis: { type: "category", data: yCats, inverse: true, ...axisBase, axisLine: { show: false } },
        visualMap: {
          min: vals.length ? Math.min(...vals) : 0,
          max: vals.length ? Math.max(...vals) : 1,
          calculable: false,
          orient: "horizontal",
          left: "center",
          bottom: 4,
          itemWidth: 10,
          itemHeight: 120,
          textStyle: text,
          inRange: { color: [t.grid, t.series[0]] },
        },
        series,
      },
    };
  } else {
    spec.y.forEach((y, si) => {
      const yi = col(y.field);
      const color = t.series[si % t.series.length] as string;
      let pts: Array<[number | string, number | null]> = spec.rows.map((r) => [
        isTime ? (time(r[xi]) ?? 0) : spec.x.type === "value" ? (num(r[xi]) ?? 0) : String(r[xi] ?? ""),
        num(r[yi]),
      ]);
      if (spec.scale === "index_100") {
        const first = pts.find((p) => p[1] !== null && p[1] !== 0)?.[1] ?? null;
        pts = pts.map(([x, v]) => [x, v === null || first === null ? null : (v / first) * 100]);
      }
      const base = {
        name: y.unit ? `${y.field} (${y.unit})` : y.field,
        yAxisIndex: y.side === "right" ? 1 : 0,
        data: isTime || spec.x.type === "value" ? pts : pts.map((p) => p[1]),
        itemStyle: { color },
        lineStyle: { color, width: style.lineWidth ?? 1.5 },
        animation: animate,
        emphasis: { disabled: pts.length > 5000, focus: "series" },
      };
      if (spec.kind === "scatter")
        series.push({
          ...base,
          type: "scatter",
          symbolSize: style.symbolSize,
          large: true,
          largeThreshold: 2000,
          itemStyle: { color, opacity: 0.7 },
        });
      else if (spec.kind === "bar")
        series.push({
          ...base,
          type: "bar",
          barMaxWidth: style.barMaxWidth,
          itemStyle: { color, borderRadius: [2, 2, 0, 0] },
        });
      else
        series.push({
          ...base,
          type: "line",
          showSymbol: pts.length <= 80,
          symbolSize: 5,
          connectNulls: false, // gaps are breaks, never interpolated
          ...(spec.kind === "area" ? { areaStyle: { color, opacity: style.areaOpacity } } : {}),
        });
    });

    const first = series[0];
    if (first && isTime) {
      const areas: unknown[] = (spec.gaps ?? []).map((g) => [
        { xAxis: Date.parse(g.from), name: `missing: ${g.reason}`, itemStyle: { color: t.gap } },
        { xAxis: Date.parse(g.to) },
      ]);
      const lines: unknown[] = [];
      for (const m of spec.markers ?? []) {
        const mk = markerToOption(m, t);
        if (mk.area) areas.push(mk.area);
        if (mk.line) lines.push(mk.line);
      }
      first.markArea = { silent: true, label: { ...text, position: "insideTop" }, data: areas };
      first.markLine = {
        silent: true,
        symbol: "none",
        lineStyle: { color: t.marker, type: "dashed", width: 1 },
        label: { color: t.marker, fontSize: 11, fontFamily: t.fontFamily },
        data: lines,
      };
    }
  }

  const multi = spec.y.length > 1 && spec.kind !== "candlestick";
  const option: EChartsOption = {
    animation: animate,
    animationDuration: 320,
    animationDurationUpdate: 260,
    animationEasing: "cubicOut",
    animationEasingUpdate: "cubicOut",
    backgroundColor: "transparent",
    textStyle: text,
    grid: { left: 52, right: rightUnit ? 52 : 16, top: multi ? 34 : 24, bottom: 28, containLabel: false },
    legend: multi
      ? { top: 0, left: 8, itemWidth: 10, itemHeight: 3, icon: "roundRect", itemGap: 14, textStyle: text }
      : undefined,
    tooltip: tooltip(t, spec.kind === "scatter" ? "item" : "axis"),
    xAxis: {
      type: isTime ? "time" : spec.x.type === "value" ? "value" : "category",
      ...axisBase,
      splitLine: { show: false },
      ...(isTime || spec.x.type === "value" ? {} : { data: spec.rows.map((r) => String(r[xi] ?? "")) }),
    },
    yAxis,
    series,
    brush:
      o.brush && isTime
        ? {
            xAxisIndex: 0,
            brushMode: "single",
            throttleType: "debounce",
            throttleDelay: 150,
            transformable: false,
            brushStyle: { color: t.marker, opacity: 0.12, borderColor: t.marker },
          }
        : undefined,
    toolbox: { show: false },
    dataZoom: isTime ? [{ type: "inside", xAxisIndex: 0, filterMode: "none", throttle: 50 }] : undefined,
  };
  return { option, points };
}

function tooltip(t: ChartTheme, trigger: "axis" | "item" = "axis") {
  return {
    trigger,
    renderMode: "richText", // canvas text: label content can never become markup
    confine: true,
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.fg, fontSize: 12, fontFamily: t.fontFamily },
    axisPointer: {
      type: "line",
      lineStyle: { color: t.muted, type: "dashed", width: 1 },
      label: { show: false },
    },
  };
}

function markerToOption(m: ChartMarker, t: ChartTheme): { area?: unknown; line?: unknown } {
  if (m.kind === "time_range")
    return {
      area: [
        {
          xAxis: Date.parse(m.start),
          name: m.label ?? "marker",
          itemStyle: { color: t.marker, opacity: 0.13 },
        },
        { xAxis: Date.parse(m.end) },
      ],
    };
  if (m.kind === "time_point") return { line: { xAxis: Date.parse(m.at), name: m.label ?? "marker" } };
  return { line: { yAxis: m.value, name: m.label ?? `${m.op === "gt" ? ">" : "<"} ${m.value}` } };
}

/** Screen-reader text alternative generated from the declared spec only (units, ranges, gaps, downsampling). */
export function chartTextAlternative(spec: ChartSpec): string {
  const parts = [`${spec.title}. ${spec.kind} chart with ${spec.rows.length} rows.`];
  for (const y of spec.y) {
    const i = spec.columns.findIndex((c) => c.name === y.field);
    const vals = spec.rows.map((r) => num(r[i])).filter((v): v is number => v !== null);
    if (vals.length)
      parts.push(
        `${y.field}${y.unit ? ` in ${y.unit}` : ""}: min ${Math.min(...vals)}, max ${Math.max(...vals)}, ${spec.rows.length - vals.length} missing.`,
      );
  }
  if (spec.gaps?.length)
    parts.push(`${spec.gaps.length} gap${spec.gaps.length > 1 ? "s" : ""} shown shaded, not interpolated.`);
  if (spec.downsampling && spec.downsampling.method !== "none")
    parts.push(`Downsampled by ${spec.downsampling.method} from ${spec.downsampling.originalPoints} points.`);
  return parts.join(" ");
}

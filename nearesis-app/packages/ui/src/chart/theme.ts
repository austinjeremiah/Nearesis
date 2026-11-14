import type { ChartKind } from "../types";

/** Resolved chart palette. Read from CSS tokens so light and dark share one source of truth. */
export interface ChartTheme {
  fg: string;
  muted: string;
  grid: string;
  surface: string;
  border: string;
  series: string[];
  gap: string;
  marker: string;
  up: string;
  down: string;
  fontFamily: string;
  monoFamily: string;
}

const FALLBACK: ChartTheme = {
  fg: "#14181f",
  muted: "#566170",
  grid: "#e9ecf0",
  surface: "#ffffff",
  border: "#dfe3e9",
  series: ["#2f62c9", "#b8650c", "#167a6c", "#b13a72", "#6d6a1a", "#566170"],
  gap: "rgba(179,38,30,0.07)",
  marker: "#5b4bb5",
  up: "#17703f",
  down: "#b3261e",
  fontFamily: "system-ui, sans-serif",
  monoFamily: "ui-monospace, monospace",
};

export function readChartTheme(el?: Element | null): ChartTheme {
  if (typeof window === "undefined") return FALLBACK;
  const cs = getComputedStyle(el ?? document.documentElement);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    fg: v("--fg", FALLBACK.fg),
    muted: v("--fg-muted", FALLBACK.muted),
    grid: v("--grid", FALLBACK.grid),
    surface: v("--surface", FALLBACK.surface),
    border: v("--border", FALLBACK.border),
    series: ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6"].map((n, i) =>
      v(n, FALLBACK.series[i] as string),
    ),
    gap: v("--gap", FALLBACK.gap),
    marker: v("--marker", FALLBACK.marker),
    up: v("--up", FALLBACK.up),
    down: v("--down", FALLBACK.down),
    fontFamily: v("--font-sans", FALLBACK.fontFamily),
    monoFamily: v("--font-mono", FALLBACK.monoFamily),
  };
}

/** Per-kind visual constants (documented in DESIGN_SPEC.md section 5). */
export const CHART_STYLE: Record<
  ChartKind,
  { lineWidth?: number; areaOpacity?: number; barMaxWidth?: number; symbolSize?: number }
> = {
  line: { lineWidth: 1.75 },
  area: { lineWidth: 1.75, areaOpacity: 0.12 },
  bar: { barMaxWidth: 26 },
  scatter: { symbolSize: 3 },
  heatmap: {},
  candlestick: {},
};

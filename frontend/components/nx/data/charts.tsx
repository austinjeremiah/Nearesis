'use client';

import { useMemo } from 'react';
import { Chart, baseOption, type ChartTheme } from '@/components/nx/chart';
import { toNum } from '@/lib/data/num';

type Pt = { x: string; y: string | number | null | undefined };

/**
 * Series colours for the data pages. Mid-tone hues that hold on the cream cards and on dark surfaces alike; a chart
 * picks its first colour with `hue`, so neighbouring cards do not all read the same.
 */
export const DATA_COLORS = ['#2f6fed', '#00a676', '#f08c2e', '#c0399f', '#7a5af8', '#e5484d', '#0e9aa7', '#b58a00'];
const dataColor = (i: number) => DATA_COLORS[((i % DATA_COLORS.length) + DATA_COLORS.length) % DATA_COLORS.length]!;
const fade = (c: string) => ({ type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: `${c}55` }, { offset: 1, color: `${c}05` }] });
/** Multi-colour sequential ramp for the heatmap: low is cool, high is hot. */
export const HEAT_COLORS = ['#3b4cc0', '#2aa5d6', '#3fc78a', '#f2d13d', '#f08c2e', '#d7302f'];

/**
 * Daily or weekly series. A null value stays null (a gap), never 0. The y values
 * are parsed from the API's exact decimal strings for drawing only.
 */
export function SeriesChart({
  series,
  height = 220,
  ariaLabel,
  unit,
  kind = 'line',
  stack = false,
  area = false,
  hue = 0,
}: {
  series: { name: string; points: Pt[] }[];
  height?: number;
  ariaLabel: string;
  unit?: string;
  kind?: 'line' | 'bar';
  /** Stack the series (bars of parts that add up to a whole). */
  stack?: boolean;
  /** Soft fill under a line. Gaps stay gaps. */
  area?: boolean;
  /** Index of the first series colour. */
  hue?: number;
}) {
  const option = useMemo(
    () => (t: ChartTheme) => {
      const base = baseOption(t) as Record<string, unknown>;
      return {
        ...base,
        legend: { ...(base.legend as object), show: series.length > 1, top: 0 },
        xAxis: {
          ...(base.xAxis as object),
          type: 'category',
          data: series[0]?.points.map((p) => p.x) ?? [],
          boundaryGap: kind === 'bar',
          axisLabel: { ...((base.xAxis as { axisLabel: object }).axisLabel), formatter: (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v.slice(5) : v) },
        },
        // room above the plot for the unit label, which otherwise clips against the card edge
        grid: { ...(base.grid as object), top: unit ? 30 : 18 },
        yAxis: { ...(base.yAxis as object), name: unit, nameTextStyle: { color: t.text3, fontSize: 10 } },
        series: series.map((s, i) => ({
          name: s.name,
          type: kind,
          ...(stack ? { stack: 'total' } : {}),
          showSymbol: false,
          connectNulls: false,
          itemStyle: { color: dataColor(hue + i), ...(kind === 'bar' ? { borderRadius: [2, 2, 0, 0] } : {}) },
          lineStyle: { color: dataColor(hue + i), width: 2 },
          ...(kind === 'bar' ? { barMaxWidth: 22 } : {}),
          ...(kind === 'line' && area && !stack ? { areaStyle: { color: fade(dataColor(hue + i)) } } : {}),
          emphasis: { focus: 'series' },
          data: s.points.map((p) => toNum(p.y)),
        })),
      };
    },
    [series, unit, kind, stack, area, hue],
  );
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
}

/** Origin x destination matrix. Cells with no swaps are blank; they are unobserved pairs, not zero-volume ones. */
export function MatrixHeatmap({
  cells,
  ariaLabel,
  unit = 'swaps',
  height = 440,
}: {
  cells: { x: string; y: string; value: number }[];
  ariaLabel: string;
  unit?: string;
  height?: number;
}) {
  const xs = useMemo(() => [...new Set(cells.map((c) => c.x))], [cells]);
  const ys = useMemo(() => [...new Set(cells.map((c) => c.y))], [cells]);
  const max = useMemo(() => Math.max(1, ...cells.map((c) => c.value)), [cells]);
  const option = useMemo(
    () => (t: ChartTheme) => {
      const base = baseOption(t) as Record<string, unknown>;
      return {
        ...base,
        grid: { left: 76, right: 16, top: 10, bottom: 104 },
        tooltip: {
          ...(base.tooltip as object),
          trigger: 'item',
          formatter: (p: { value: [number, number, number, number] }) => `${ys[p.value[1]]} to ${xs[p.value[0]]}<br/><b>${p.value[3].toLocaleString('en-US')}</b> ${unit}`,
        },
        xAxis: { type: 'category', data: xs, name: 'destination', nameLocation: 'middle', nameGap: 50, axisLabel: { color: t.text3, fontSize: 10, rotate: 45, interval: 0 }, splitArea: { show: false } },
        yAxis: { type: 'category', data: ys, name: 'origin', axisLabel: { color: t.text3, fontSize: 10, interval: 0 } },
        // Colour follows log10(value + 1): a handful of routes carry most of the flow, and on a linear scale every other
        // cell would share one colour. The tooltip always shows the real value.
        visualMap: {
          min: 0,
          max: Math.log10(max + 1),
          dimension: 2,
          calculable: false,
          orient: 'horizontal',
          left: 'center',
          bottom: 0,
          itemWidth: 12,
          itemHeight: 180,
          text: [`${max.toLocaleString('en-US')} ${unit}`, 'low'],
          inRange: { color: HEAT_COLORS },
          textStyle: { color: t.text3, fontSize: 10 },
        },
        series: [
          {
            type: 'heatmap',
            data: cells.map((c) => [xs.indexOf(c.x), ys.indexOf(c.y), Math.log10(Math.max(0, c.value) + 1), c.value]),
            label: { show: false },
            itemStyle: { borderColor: 'rgba(0,0,0,0.06)', borderWidth: 1 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
          },
        ],
      };
    },
    [cells, xs, ys, max, unit],
  );
  // one readable row per origin chain: the card grows with the number of chains instead of stacking the labels
  return <Chart option={option} height={Math.max(height, ys.length * 15 + 150)} ariaLabel={ariaLabel} />;
}

/** Share bar with its number beside it, for tables. */
export function ShareBar({ share }: { share: string | number | null | undefined }) {
  const n = toNum(share);
  if (n === null) return <span className="dim">—</span>;
  return (
    <span className="dbar-track" aria-hidden="true">
      <span className="dbar" style={{ width: `${Math.min(100, Math.max(0, n * 100))}%` }} />
    </span>
  );
}

/**
 * Tiny trend line for a tile. No axes and no tooltip, so it is a shape, not a reading: the tile's number
 * carries the value. A null point is a gap in the line.
 */
export function Sparkline({ points, ariaLabel, height = 40, kind = 'line', hue = 0 }: { points: Pt[]; ariaLabel: string; height?: number; kind?: 'line' | 'bar'; hue?: number }) {
  const option = useMemo(
    () => (_t: ChartTheme) => {
      const c = dataColor(hue);
      return {
        backgroundColor: 'transparent',
        animation: false,
        grid: { left: 2, right: 2, top: 4, bottom: 2 },
        tooltip: { show: false },
        xAxis: { type: 'category', show: false, boundaryGap: kind === 'bar', data: points.map((p) => p.x) },
        yAxis: { type: 'value', show: false, scale: kind === 'line' },
        series: [
          {
            type: kind,
            silent: true,
            showSymbol: false,
            connectNulls: false,
            data: points.map((p) => toNum(p.y)),
            itemStyle: { color: c, borderRadius: [1, 1, 0, 0] },
            lineStyle: { color: c, width: 2 },
            areaStyle: kind === 'line' ? { color: fade(c) } : undefined,
            barMaxWidth: 6,
          },
        ],
      };
    },
    [points, kind, hue],
  );
  return <Chart option={option} height={height} ariaLabel={ariaLabel} className="dx-spark" />;
}

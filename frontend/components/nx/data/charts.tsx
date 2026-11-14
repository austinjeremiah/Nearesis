'use client';

import { useMemo } from 'react';
import { Chart, baseOption, heatRamp, seriesPalette, type ChartTheme } from '@/components/nx/chart';
import { toNum } from '@/lib/data/num';

type Pt = { x: string; y: string | number | null | undefined };

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
}: {
  series: { name: string; points: Pt[] }[];
  height?: number;
  ariaLabel: string;
  unit?: string;
  kind?: 'line' | 'bar';
  /** Stack the series (bars of parts that add up to a whole). */
  stack?: boolean;
}) {
  const option = useMemo(
    () => (t: ChartTheme) => {
      const base = baseOption(t) as Record<string, unknown>;
      const pal = seriesPalette(t);
      return {
        ...base,
        legend: { ...(base.legend as object), show: series.length > 1, top: 0 },
        xAxis: { ...(base.xAxis as object), type: 'category', data: series[0]?.points.map((p) => p.x) ?? [] },
        yAxis: { ...(base.yAxis as object), name: unit, nameTextStyle: { color: t.text3, fontSize: 10 } },
        series: series.map((s, i) => ({
          name: s.name,
          type: kind,
          ...(stack ? { stack: 'total' } : {}),
          showSymbol: false,
          connectNulls: false,
          itemStyle: { color: pal[i % pal.length] },
          lineStyle: { color: pal[i % pal.length], width: 2 },
          data: s.points.map((p) => toNum(p.y)),
        })),
      };
    },
    [series, unit, kind, stack],
  );
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
}

/** Origin x destination matrix. Cells with no swaps are blank; they are unobserved pairs, not zero-volume ones. */
export function MatrixHeatmap({
  cells,
  ariaLabel,
  unit = 'swaps',
  height = 360,
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
        grid: { left: 70, right: 16, top: 10, bottom: 70 },
        tooltip: { ...(base.tooltip as object), trigger: 'item' },
        xAxis: { type: 'category', data: xs, name: 'destination', nameLocation: 'middle', nameGap: 48, axisLabel: { color: t.text3, fontSize: 10, rotate: 45 }, splitArea: { show: false } },
        yAxis: { type: 'category', data: ys, name: 'origin', axisLabel: { color: t.text3, fontSize: 10 } },
        visualMap: { min: 0, max, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: heatRamp(t) }, textStyle: { color: t.text3 } },
        series: [
          {
            type: 'heatmap',
            data: cells.map((c) => [xs.indexOf(c.x), ys.indexOf(c.y), c.value]),
            label: { show: false },
            tooltip: { valueFormatter: (v: unknown) => `${v} ${unit}` },
          },
        ],
      };
    },
    [cells, xs, ys, max, unit],
  );
  return <Chart option={option} height={height} ariaLabel={ariaLabel} />;
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

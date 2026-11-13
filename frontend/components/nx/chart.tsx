'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import {
  BarChart,
  BoxplotChart,
  CandlestickChart,
  CustomChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
} from 'echarts/charts';
import {
  BrushComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

/**
 * Chart engine.
 *
 * ECharts rather than an SVG library, for reasons the spec forces: section 5.7
 * requires 50 panels and 100k points downsampled with detail on demand, and
 * section 6.3 requires heatmap and candlestick. SVG renderers put a DOM node per
 * point and start failing an order of magnitude below that.
 *
 * Only the chart types and components actually used are registered, so the
 * bundle carries the pieces this product needs and nothing else.
 */
echarts.use([
  LineChart,
  BarChart,
  ScatterChart,
  HeatmapChart,
  CandlestickChart,
  BoxplotChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  BrushComponent,
  MarkAreaComponent,
  MarkLineComponent,
  VisualMapComponent,
  CanvasRenderer,
]);

/**
 * Theme read from the CSS custom properties, so a chart inherits the same cream,
 * ink and NEAR green as the rest of the page and follows a theme switch without
 * a second palette to maintain.
 */
function readTheme(el: HTMLElement) {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#00ec97'),
    ink: v('--text', '#000000'),
    text2: v('--text-2', '#4a4940'),
    text3: v('--text-3', '#76756a'),
    line: v('--line', 'rgba(0,0,0,0.14)'),
    lineStrong: v('--line-strong', 'rgba(0,0,0,0.34)'),
    surface: v('--surface', '#f7f6ef'),
    page: v('--page', '#f1efe2'),
    bad: v('--bad', '#9c2b27'),
    info: v('--info', '#22508f'),
    warn: v('--warn', '#7d5209'),
    font: v('--font', 'Inter Tight, sans-serif'),
    mono: v('--font-mono', 'IBM Plex Mono, monospace'),
  };
}

export type ChartTheme = ReturnType<typeof readTheme>;

/**
 * Categorical series colours. Ordered for distinguishability rather than
 * prettiness, and checked to stay legible on cream. The accent leads because the
 * first series is usually the subject of the question.
 */
export function seriesPalette(t: ChartTheme): string[] {
  // Ink leads. The NEAR green is the product's accent and it is doing work
  // elsewhere on the page (status, budget, selection); using it for the data
  // line as well made every chart read as a marketing graphic rather than a
  // measurement. Green stays for the second series, where contrast against the
  // first is the whole point.
  return [t.ink, t.accent, t.info, t.warn, t.bad, '#6b8f7a', '#8a6fae', '#a08b5e'];
}

/** 4_532_826 -> "4.53M". Long tick labels were being clipped by the plot edge. */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (abs > 0 && abs < 1) return String(Number(n.toFixed(4)));
  return String(n);
}

/** Axis, grid and tooltip defaults shared by every panel. */
export function baseOption(t: ChartTheme): Record<string, unknown> {
  return {
    backgroundColor: 'transparent',
    animationDuration: 180,
    textStyle: { fontFamily: t.font, color: t.text2, fontSize: 11 },
    // containLabel lets the axis labels size the plot area. With a fixed left
    // inset a seven-figure tick was simply cut off at the edge of the canvas.
    grid: { left: 6, right: 16, top: 18, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2a2a2a',
      borderWidth: 0,
      padding: [6, 9],
      textStyle: { color: '#f1efe2', fontFamily: t.font, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: t.lineStrong, width: 1, type: 'dashed' } },
      // Spec 4.4: a gap in the data is reported, never interpolated away.
      valueFormatter: (val: unknown) =>
        val === null || val === undefined
          ? '—'
          : typeof val === 'number'
            ? val.toLocaleString('en-US', { maximumFractionDigits: 4 })
            : String(val),
    },
    xAxis: {
      type: 'time',
      // Fewer ticks, and a label is dropped rather than printed over its
      // neighbour. Dense day ticks were colliding with the month markers.
      splitNumber: 5,
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: t.text3,
        fontFamily: t.mono,
        fontSize: 10,
        // Drop a label rather than print it on top of its neighbour, and carry
        // the month on every day label so a bare "17" is never left to guess at.
        hideOverlap: true,
        formatter: { day: '{d} {MMM}', month: '{MMM}', year: '{yyyy}' },
      },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: t.line, type: 'solid' } },
      axisLabel: {
        color: t.text3,
        fontFamily: t.mono,
        fontSize: 10,
        hideOverlap: true,
        formatter: (v: number) => compactNumber(v),
      },
    },
    legend: {
      show: false,
      textStyle: { color: t.text2, fontFamily: t.font, fontSize: 11 },
      icon: 'rect',
      itemWidth: 9,
      itemHeight: 9,
    },
  };
}

/**
 * Thin React binding. Written here rather than pulled from a wrapper package so
 * disposal, resize and theme re-read stay under our control and the chart cannot
 * leak an observer when a canvas of 50 panels unmounts.
 */
export function Chart({
  option,
  height = 240,
  /** Called when the user finishes dragging a range. The caller decides whether
   *  that becomes a marker; spec 5.7 says a selection alone spawns nothing. */
  onBrushEnd,
  ariaLabel,
  className,
}: {
  option: (t: ChartTheme) => Record<string, unknown>;
  height?: number;
  onBrushEnd?: (range: { start: string; end: string }) => void;
  ariaLabel: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const brushCb = useRef(onBrushEnd);
  brushCb.current = onBrushEnd;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    inst.current = chart;
    chart.setOption(option(readTheme(el)));

    if (brushCb.current) {
      chart.on('brushEnd', (params: unknown) => {
        const areas = (params as { areas?: { coordRange?: [number, number] }[] }).areas;
        const range = areas?.[0]?.coordRange;
        if (!range) return;
        brushCb.current?.({
          start: new Date(range[0]).toISOString(),
          end: new Date(range[1]).toISOString(),
        });
      });
    }

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);

    // Re-read the palette when the theme attribute flips, so a dark-mode switch
    // does not leave charts drawn in light-mode ink.
    const mo = new MutationObserver(() => chart.setOption(option(readTheme(el))));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
      chart.dispose();
      inst.current = null;
    };
    // `option` is a closure over the caller's data; re-running on identity change
    // is intended and setOption merges rather than rebuilding.
  }, [option]);

  useEffect(() => {
    const el = host.current;
    if (el && inst.current) inst.current.setOption(option(readTheme(el)));
  }, [option]);

  return (
    <div
      ref={host}
      className={`chart ${className ?? ''}`.trim()}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    />
  );
}

/**
 * Spec 4.4: an empty series keeps its coordinate space and states the reason.
 * It must never be replaced by a pleasing invented curve or a blank box.
 */
export function BlankChart({
  reason,
  height = 240,
  ariaLabel,
}: {
  reason: string;
  height?: number;
  ariaLabel: string;
}) {
  return (
    <div className="chart" style={{ height }} role="img" aria-label={`${ariaLabel}. ${reason}`}>
      {/*
        The axes are drawn with borders rather than an SVG. Geometry attributes
        such as x2 do not accept calc(), so the previous version drew a line
        that ran past the edge of its panel.
      */}
      <div className="chart-axes" aria-hidden="true" />
      <div className="chart-blank">{reason}</div>
    </div>
  );
}

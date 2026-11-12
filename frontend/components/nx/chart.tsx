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
  PieChart,
  ScatterChart,
} from 'echarts/charts';
import {
  BrushComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { LegacyGridContainLabel } from 'echarts/features';

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
  PieChart,
  BarChart,
  ScatterChart,
  HeatmapChart,
  CandlestickChart,
  BoxplotChart,
  CustomChart,
  GraphicComponent,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  BrushComponent,
  MarkAreaComponent,
  MarkLineComponent,
  VisualMapComponent,
  LegacyGridContainLabel,
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
  return [t.accent, '#1f1f1f', t.info, t.warn, t.bad, '#6b8f7a', '#8a6fae', '#a08b5e'];
}

/** Axis, grid and tooltip defaults shared by every panel. */
export function baseOption(t: ChartTheme): Record<string, unknown> {
  return {
    backgroundColor: 'transparent',
    animationDuration: 180,
    textStyle: { fontFamily: t.font, color: t.text2, fontSize: 11 },
    grid: { left: 52, right: 16, top: 18, bottom: 28, containLabel: false },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#2a2a2a',
      borderWidth: 0,
      padding: [6, 9],
      textStyle: { color: '#f1efe2', fontFamily: t.font, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: t.lineStrong, width: 1, type: 'dashed' } },
      // Spec 4.4: a gap in the data is reported, never interpolated away.
      valueFormatter: (val: unknown) => (val === null || val === undefined ? '—' : String(val)),
    },
    xAxis: {
      type: 'time',
      axisLine: { lineStyle: { color: t.lineStrong } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: t.line, type: 'solid' } },
      axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
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
  /** Arms drag-to-select of a horizontal range inside the plot area. */
  brushActive,
  ariaLabel,
  className,
}: {
  option: (t: ChartTheme) => Record<string, unknown>;
  height?: number;
  onBrushEnd?: (range: { start: string; end: string }) => void;
  brushActive?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const brushCb = useRef(onBrushEnd);
  brushCb.current = onBrushEnd;
  const optRef = useRef(option);
  optRef.current = option;
  const brushRef = useRef(brushActive);
  brushRef.current = brushActive;

  const paint = (chart: echarts.ECharts, el: HTMLElement) => {
    chart.setOption(optRef.current(readTheme(el)), { notMerge: true });
  };

  // Create once per mount: disposal, resize and theme observers stay tied to this element.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    inst.current = chart;
    paint(chart, el);

    // Horizontal range selection by dragging inside the plot area. Done on the zrender layer so
    // it needs no toolbox component; the caller receives ISO strings and decides what to do.
    const zr = chart.getZr();
    let from: number | null = null;
    const gridRect = () => {
      const m = (chart as unknown as { getModel(): { getComponent(n: string, i: number): { coordinateSystem?: { getRect(): { x: number; y: number; width: number; height: number } } } | undefined } }).getModel();
      return m.getComponent('grid', 0)?.coordinateSystem?.getRect() ?? null;
    };
    const clampX = (x: number, r: { x: number; width: number }) => Math.max(r.x, Math.min(r.x + r.width, x));
    zr.on('mousedown', (e: { offsetX: number; offsetY: number }) => {
      if (!brushRef.current || !brushCb.current) return;
      const r = gridRect();
      if (r && e.offsetX >= r.x && e.offsetX <= r.x + r.width && e.offsetY >= r.y && e.offsetY <= r.y + r.height) from = e.offsetX;
    });
    zr.on('mousemove', (e: { offsetX: number }) => {
      const r = gridRect();
      if (from === null || !r) return;
      const x2 = clampX(e.offsetX, r);
      chart.setOption({
        graphic: [{ id: 'nx-brush', type: 'rect', silent: true, z: 100, shape: { x: Math.min(from, x2), y: r.y, width: Math.abs(x2 - from), height: r.height }, style: { fill: 'rgba(0,236,151,0.16)', stroke: readTheme(el).accent } }],
      });
    });
    const finish = (x: number | null) => {
      const r = gridRect();
      const a = from;
      from = null;
      if (a === null || !r) return;
      chart.setOption({ graphic: [{ id: 'nx-brush', $action: 'remove' }] });
      if (x === null || Math.abs(x - a) < 4) return;
      const lo = chart.convertFromPixel({ xAxisIndex: 0 }, Math.min(a, clampX(x, r))) as unknown as number;
      const hi = chart.convertFromPixel({ xAxisIndex: 0 }, Math.max(a, clampX(x, r))) as unknown as number;
      if (Number.isFinite(lo) && Number.isFinite(hi)) brushCb.current?.({ start: new Date(lo).toISOString(), end: new Date(hi).toISOString() });
    };
    zr.on('mouseup', (e: { offsetX: number }) => finish(e.offsetX));
    zr.on('globalout', () => finish(null));

    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    // Re-read the palette when the theme attribute flips.
    const mo = new MutationObserver(() => paint(chart, el));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      ro.disconnect();
      mo.disconnect();
      chart.dispose();
      inst.current = null;
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (el && inst.current) paint(inst.current, el);
  }, [option, brushActive]);

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
      <svg width="100%" height="100%" aria-hidden="true">
        <line x1="52" y1="8" x2="52" y2="calc(100% - 28px)" stroke="var(--line-strong)" strokeWidth="1" />
        <line
          x1="52"
          y1="calc(100% - 28px)"
          x2="calc(100% - 16px)"
          y2="calc(100% - 28px)"
          stroke="var(--line-strong)"
          strokeWidth="1"
        />
      </svg>
      <div className="chart-blank">{reason}</div>
    </div>
  );
}

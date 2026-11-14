'use client';

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { Pt } from '@/lib/report/model';

echarts.use([LineChart, BarChart, GridComponent, LegendComponent, SVGRenderer]);

/** Fixed light palette: the report ignores the app theme, so the colours are not read from the page. */
const INK = '#1a1a14';
const MUTED = '#6b6a5e';
const RULE = '#d9d7c6';
export const REPORT_PALETTE = ['#0a8f5f', '#1a1a14', '#22508f', '#a06a0a', '#9c2b27', '#6b8f7a'];

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });

/**
 * A print chart. SVG renderer (vector, stays sharp in the PDF), animation off, fixed pixel width so the PDF matches the
 * screen. A null point is a gap in the line, never 0. It marks itself `data-ready` once ECharts has finished drawing, which
 * the PDF renderer waits for.
 */
export function ReportChart({
  type,
  x,
  series,
  unit,
  height = 190,
  ariaLabel,
}: {
  type: 'line' | 'bar';
  x: string[];
  series: { name: string; points: Pt[] }[];
  unit: string | null;
  height?: number;
  ariaLabel: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.dataset.ready = 'false';
    const chart = echarts.init(el, undefined, { renderer: 'svg', width: el.clientWidth || 640, height });
    chart.on('finished', () => {
      el.dataset.ready = 'true';
    });
    const many = x.length > 40;
    chart.setOption({
      animation: false,
      backgroundColor: 'transparent',
      textStyle: { fontFamily: 'IBM Plex Mono, ui-monospace, monospace', color: MUTED, fontSize: 9 },
      grid: { left: 54, right: 12, top: series.length > 1 ? 26 : 12, bottom: type === 'bar' ? 58 : 26 },
      legend: { show: series.length > 1, top: 0, left: 0, icon: 'rect', itemWidth: 8, itemHeight: 8, itemGap: 16, textStyle: { color: INK, fontSize: 9, fontFamily: 'Inter Tight, sans-serif' } },
      xAxis: {
        type: 'category',
        data: x,
        boundaryGap: type === 'bar',
        axisLine: { lineStyle: { color: '#8a897b' } },
        axisTick: { show: false },
        axisLabel: { color: MUTED, fontSize: 9, interval: type === 'bar' ? 0 : many ? Math.ceil(x.length / 6) - 1 : 'auto', rotate: type === 'bar' ? 30 : 0, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: unit ?? undefined,
        nameTextStyle: { color: MUTED, fontSize: 9, align: 'left' },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: RULE } },
        axisLabel: { color: MUTED, fontSize: 9, formatter: (v: number) => compact.format(v) },
      },
      series: series.map((s, i) => ({
        name: s.name,
        type,
        showSymbol: false,
        connectNulls: false,
        animation: false,
        barMaxWidth: 28,
        itemStyle: { color: REPORT_PALETTE[i % REPORT_PALETTE.length] },
        lineStyle: { color: REPORT_PALETTE[i % REPORT_PALETTE.length], width: 1.6 },
        data: s.points.map((p) => p.y),
      })),
    });
    // 'finished' fires after the first frame; mark ready even if it was already emitted synchronously.
    requestAnimationFrame(() => {
      if (el.dataset.ready !== 'true') requestAnimationFrame(() => (el.dataset.ready = 'true'));
    });
    return () => chart.dispose();
  }, [type, x, series, unit, height]);
  return <div ref={host} className="rp-chart" data-report-chart="" style={{ height }} role="img" aria-label={ariaLabel} />;
}

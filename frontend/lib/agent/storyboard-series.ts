import { bind, toNum, toTime } from '@/lib/panel/model';
import type { CanvasPanel, PanelData } from '@/lib/panel/types';

export type SeriesPoint = { t: number; v: number | null };
export type Series = { name: string; unit: string | null; points: SeriesPoint[] };

/**
 * One plotted column of a panel as time/value points. A missing value stays null (a gap), never zero. When `column` is
 * not given the panel's first plotted column is used. Null when the panel's data has no time axis to draw against.
 */
export function seriesOf(panel: Pick<CanvasPanel, 'encoding'>, data: PanelData | undefined, column?: string): Series | null {
  const chart = data?.chart;
  if (!data || !chart) return null;
  const b = bind(panel, data);
  const y = column && b.ys.includes(column) ? column : b.ys[0];
  if (!b.x || !y) return null;
  const xi = chart.columns.findIndex((c) => c.name === b.x);
  const yi = chart.columns.findIndex((c) => c.name === y);
  if (xi < 0 || yi < 0) return null;
  const points: SeriesPoint[] = [];
  for (const row of chart.rows as unknown[][]) {
    const t = toTime(row[xi]);
    if (t !== null) points.push({ t, v: toNum(row[yi]) });
  }
  points.sort((a, c) => a.t - c.t);
  return points.length ? { name: y, unit: chart.columns[yi]?.unit ?? null, points } : null;
}

/** The panel that plots a metric, so a monitor on that metric can show the series it watches. */
export function panelForMetric<P extends Pick<CanvasPanel, 'encoding' | 'kind'>>(panels: P[], metricId: string): P | null {
  return panels.find((p) => p.kind === 'timeSeries' && (p.encoding?.y ?? []).includes(metricId)) ?? null;
}

/** x positions for a polyline over [t0, t1] and y over [lo, hi]; gaps break the line into separate runs. */
export function plotRuns(points: SeriesPoint[], w: number, h: number, pad: { t: number; b: number; l: number; r: number }, yDomain: [number, number]): { x: number; y: number }[][] {
  if (points.length === 0) return [];
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const [lo, hi] = yDomain;
  const span = hi - lo || 1;
  const tx = (t: number) => pad.l + (t1 === t0 ? (w - pad.l - pad.r) / 2 : ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r));
  const ty = (v: number) => pad.t + (1 - (v - lo) / span) * (h - pad.t - pad.b);
  const runs: { x: number; y: number }[][] = [];
  let cur: { x: number; y: number }[] = [];
  for (const p of points) {
    if (p.v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
    } else cur.push({ x: tx(p.t), y: ty(p.v) });
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** The value domain, widened to include extra values (a threshold) and padded slightly so a line does not touch the frame. */
export function yDomainOf(points: SeriesPoint[], include: number[] = []): [number, number] {
  const vs = [...points.map((p) => p.v).filter((v): v is number => v !== null), ...include];
  if (vs.length === 0) return [0, 1];
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  return [lo - pad, hi + pad];
}

/** Where a time falls on the x axis of the plot, 0..w; null when it is outside the series. */
export function xOfTime(points: SeriesPoint[], t: number, w: number, padL: number, padR: number): number | null {
  if (points.length === 0) return null;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  if (t < t0 || t > t1) return null;
  return padL + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (w - padL - padR));
}

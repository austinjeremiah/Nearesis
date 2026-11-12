'use client';

import { useCallback, useMemo } from 'react';
import { Chart, BlankChart, seriesPalette, type ChartTheme } from '@/components/nx/chart';
import { bind, buildOption, colLabel, describeChart, fmtValue, toNum, type Viz } from '@/lib/panel/model';
import { panelSelection } from '@/lib/panel/selection';
import type { CanvasMarker, CanvasPanel, PanelData } from '@/lib/panel/types';

const ROW_LIMIT = 200;

/** Table view: also the text alternative to every chart. A null cell is shown as a dash, never 0. */
export function DataTable({ data, limit = ROW_LIMIT }: { data: PanelData; limit?: number }) {
  const chart = data.chart;
  if (!chart) return null;
  const numeric = chart.columns.map((_, i) => chart.rows.some((r) => toNum(r[i]) !== null) && chart.rows.every((r) => r[i] === null || toNum(r[i]) !== null));
  return (
    <div>
      <div className="nxp-table-wrap" tabIndex={0} role="region" aria-label="Result rows">
        <table className="nxp-table">
          <thead>
            <tr>
              {chart.columns.map((c) => (
                <th key={c.name} scope="col" title={c.name}>
                  {colLabel(c.name)}
                  {c.unit ? <span className="dim"> ({c.unit})</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.slice(0, limit).map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={v === null ? 'null' : numeric[j] ? 'num' : ''} title={v === null ? 'No value (a gap, not zero)' : undefined}>
                    {v === null ? '—' : numeric[j] ? fmtValue(v, chart.columns[j].unit) : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="tiny dim" style={{ marginTop: 4 }}>
        Showing {Math.min(limit, chart.rows.length).toLocaleString('en-US')} of {chart.rows.length.toLocaleString('en-US')} rows
        {chart.downsampling.originalPoints > chart.rows.length ? `; the source had ${chart.downsampling.originalPoints.toLocaleString('en-US')}` : ''}.
      </div>
    </div>
  );
}

export function ChartRenderer({
  wid,
  panel,
  data,
  viz,
  height,
  markers,
  window: win,
  brush,
}: {
  wid: string;
  panel: CanvasPanel;
  data: PanelData;
  viz: Viz;
  height: number;
  markers?: CanvasMarker[];
  window?: { start: string; end: string } | null;
  /** Enables range selection by dragging. The selection goes to `panelSelection`. */
  brush?: boolean;
}) {
  const alt = useMemo(() => describeChart(panel, data, viz), [panel, data, viz]);
  const timeBind = bind(panel, data).x ?? '';
  const option = useCallback(
    (t: ChartTheme) => buildOption({ panel, data, viz, theme: t, markers, window: win, palette: seriesPalette(t), brush }).option,
    [panel, data, viz, markers, win, brush],
  );
  // Whether this viz can draw is decided once with a neutral theme.
  const probe = useMemo(
    () =>
      buildOption({
        panel,
        data,
        viz,
        theme: { accent: '#00ec97', ink: '#000', text2: '#444', text3: '#777', line: '#ddd', lineStrong: '#999', surface: '#fff', warn: '#7d5209', bad: '#9c2b27', info: '#22508f', mono: 'monospace', font: 'sans-serif' },
        markers,
        window: win,
        palette: ['#00ec97'],
        brush,
      }),
    [panel, data, viz, markers, win, brush],
  );
  const onBrushEnd = useCallback(
    (r: { start: string; end: string }) =>
      panelSelection.set({ workspaceId: wid, panelId: panel.panelId, queryHash: data.queryHash, seriesId: timeBind, start: r.start, end: r.end, origin: 'brush', sourceWatermark: data.chart?.sourceWatermark ?? null }),
    [wid, panel.panelId, data.queryHash, data.chart?.sourceWatermark, timeBind],
  );
  if (!probe.supported) return <BlankChart reason={probe.reason ?? 'This data cannot draw this view.'} height={height} ariaLabel={panel.title} />;
  return (
    <div data-testid="chart" data-viz={viz} data-gaps={probe.gaps}>
      <Chart option={option} height={height} ariaLabel={alt} onBrushEnd={brush ? onBrushEnd : undefined} brushActive={!!brush} />
      <div className="nxp-sr">{alt}</div>
    </div>
  );
}

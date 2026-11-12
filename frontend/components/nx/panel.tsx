'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import type { FixturePanel } from '@/lib/data/fixtures';
import * as db from '@/lib/data/client';
import { compact } from '@/lib/data/series';
import { formatUtc, shortHash } from '@/lib/format';
import { BlankChart, Chart, baseOption, seriesPalette, type ChartTheme } from './chart';
import {
  CoverageChip,
  DataModeIndicator,
  MaturityChip,
  PanelStatusChip,
  ReasonCodeList,
} from './evidence';
import { Menu } from './overlays';
import { IconButton, KeyValues, Notice } from './ui';

/**
 * PanelFrame.
 *
 * Spec 5.7 fixes the header contract: title, metric and unit, source maturity,
 * an as-of timestamp, and the overflow menu. Spec 4.2 fixes what the inspector
 * must be able to show. Both live here rather than on each screen, because a
 * panel that can render without its provenance is the failure mode the whole
 * document is written to prevent.
 */

export function usePanelOption(p: FixturePanel) {
  return useCallback(
    (t: ChartTheme) => {
      const palette = seriesPalette(t);
      const base = baseOption(t);

      if (p.kind === 'bar') {
        // Forecast error by model: a categorical comparison, not a time series.
        const x = db.fixtures.EXPERIMENTS.find((e) => e.id === 'x1');
        return {
          ...base,
          xAxis: {
            type: 'category',
            data: (x?.models ?? []).map((m) => m.label.split(' · ')[0]),
            axisLine: { lineStyle: { color: t.lineStrong } },
            axisTick: { show: false },
            axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
          },
          yAxis: { ...(base.yAxis as object), name: 'sMAPE', nameTextStyle: { color: t.text3, fontSize: 10 } },
          series: [
            {
              type: 'bar',
              data: (x?.models ?? []).map((m, i) => ({
                value: m.smape,
                itemStyle: { color: i === 1 ? t.accent : t.text3 },
              })),
              barWidth: '46%',
            },
          ],
        };
      }

      if (p.kind === 'heatmap') {
        // Route by hour availability. Values are a ratio, so the visual map is
        // bounded to 0..1 rather than scaled to whatever happens to be present.
        const routes = ['ETH→NEAR', 'SOL→NEAR', 'BTC→NEAR', 'USDC→NEAR', 'ARB→NEAR', 'BASE→NEAR'];
        const avail = db.seriesFor('quotes.availability');
        const cells: [number, number, number][] = [];
        for (let r = 0; r < routes.length; r++) {
          for (let hour = 0; hour < 24; hour++) {
            const idx = (r * 24 + hour) % avail.length;
            const v = avail[idx]?.[1];
            if (v !== null && v !== undefined) cells.push([hour, r, Number(v.toFixed(3))]);
          }
        }
        return {
          ...base,
          grid: { left: 86, right: 16, top: 12, bottom: 48 },
          tooltip: { trigger: 'item', backgroundColor: '#2a2a2a', borderWidth: 0, textStyle: { color: '#f1efe2', fontSize: 12 } },
          xAxis: {
            type: 'category',
            data: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
            axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 9, interval: 2 },
            axisLine: { lineStyle: { color: t.lineStrong } },
            axisTick: { show: false },
          },
          yAxis: {
            type: 'category',
            data: routes,
            axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { show: false },
          },
          visualMap: {
            min: 0,
            max: 1,
            calculable: false,
            orient: 'horizontal',
            left: 86,
            bottom: 0,
            itemWidth: 10,
            itemHeight: 90,
            textStyle: { color: t.text3, fontSize: 10, fontFamily: t.mono },
            inRange: { color: [t.page, t.accent] },
          },
          series: [{ type: 'heatmap', data: cells, itemStyle: { borderColor: t.page, borderWidth: 1 } }],
        };
      }

      // Default: one or more daily time series.
      const series = p.metricIds.map((id, i) => {
        const m = db.metric(id);
        const pts = db.seriesFor(id);
        return {
          name: m?.name ?? id,
          type: 'line',
          // Spec 4.4: `connectNulls: false` is the whole point. The line breaks
          // on an unavailable day instead of drawing through it.
          connectNulls: false,
          showSymbol: false,
          smooth: false,
          lineStyle: { width: 1.75, color: palette[i % palette.length] },
          itemStyle: { color: palette[i % palette.length] },
          yAxisIndex: i,
          areaStyle:
            i === 0 && p.metricIds.length === 1
              ? { color: palette[0], opacity: 0.08 }
              : undefined,
          data: pts.map(([d, v]) => [d, v]),
          // The settlement boundary is marked on volume, because the step there
          // is a visibility change and a reader should see that stated.
          markLine:
            id === 'intents.daily_volume'
              ? {
                  silent: true,
                  symbol: 'none',
                  label: {
                    formatter: 'settlement visibility change',
                    color: t.text3,
                    fontSize: 9,
                    position: 'insideEndTop',
                  },
                  lineStyle: { color: t.lineStrong, type: 'dashed', width: 1 },
                  data: [{ xAxis: db.SETTLEMENT_BOUNDARY }],
                }
              : undefined,
        };
      });

      const yAxes = p.metricIds.map((id, i) => ({
        ...(base.yAxis as object),
        position: i === 0 ? 'left' : 'right',
        axisLabel: {
          color: t.text3,
          fontFamily: t.mono,
          fontSize: 10,
          formatter: (v: number) =>
            Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v),
        },
        splitLine: i === 0 ? { lineStyle: { color: t.line } } : { show: false },
      }));

      return {
        ...base,
        legend: { ...(base.legend as object), show: p.metricIds.length > 1, top: 0, right: 0 },
        grid: { left: 52, right: p.metricIds.length > 1 ? 52 : 16, top: p.metricIds.length > 1 ? 26 : 14, bottom: 24 },
        yAxis: yAxes,
        series,
      };
    },
    [p],
  );
}

export function PanelFrame({
  panel,
  workspaceId,
  height = 240,
  onSelectRange,
  compactHeader,
}: {
  panel: FixturePanel;
  workspaceId: string;
  height?: number;
  onSelectRange?: (r: { start: string; end: string }) => void;
  compactHeader?: boolean;
}) {
  const [showProvenance, setShowProvenance] = useState(false);
  const option = usePanelOption(panel);
  const result = useMemo(() => db.resultFor(panel.metricIds), [panel.metricIds]);
  const primary = db.metric(panel.metricIds[0]);
  const points = db.seriesFor(panel.metricIds[0]);
  const hasData = compact(points).length > 0;

  return (
    <section className="card" aria-label={panel.title}>
      <header className="card-head">
        <div className="grow col gap1" style={{ minWidth: 0 }}>
          <div className="row gap2" style={{ minWidth: 0 }}>
            <span className="h3" style={{ fontSize: compactHeader ? 14 : undefined }}>
              {panel.title}
            </span>
            <PanelStatusChip status={panel.status} />
          </div>
          <div className="row gap2 wrap tiny dim">
            <span className="mono">{primary?.unit ?? ''}</span>
            <MaturityChip maturity={result.source.maturity} />
            <DataModeIndicator
              mode={result.source.dataMode}
              origin={result.source.datasetOrigin}
              watermark={result.source.sourceWatermark}
            />
            <ReasonCodeList codes={panel.reasonCodes} />
          </div>
        </div>
        <div className="actions">
          <Menu
            align="end"
            trigger={
              <IconButton label={`Panel actions for ${panel.title}`}>
                <MoreHorizontal size={15} />
              </IconButton>
            }
            items={[
              { label: 'Inspect provenance', onSelect: () => setShowProvenance((v) => !v) },
              { label: 'Open full view', href: `/w/${workspaceId}/panels/${panel.id}` },
              { kind: 'separator' },
              { label: 'Add marker', disabledReason: onSelectRange ? undefined : 'Select a range on the chart first.' },
              { label: 'Create monitor from selection', disabledReason: 'Select a range on the chart first.' },
              { kind: 'separator' },
              { label: 'Copy query hash', onSelect: () => navigator.clipboard?.writeText(result.query.canonicalQueryHash) },
              { label: 'Export data', disabledReason: 'Export needs the authorized API. Not available on fixture data.' },
              { kind: 'separator' },
              { label: 'Archive panel', danger: true, disabledReason: 'Read-only until the API is connected.' },
            ]}
          />
        </div>
      </header>

      <div className="card-body" style={{ paddingTop: 8 }}>
        {panel.status === 'error' ? (
          <>
            <Notice tone="bad" title="This panel could not be refreshed">
              {panel.error}
            </Notice>
            <BlankChart
              height={height - 60}
              reason="Last good result retained. Nothing is drawn for the failed window."
              ariaLabel={panel.title}
            />
          </>
        ) : hasData ? (
          <Chart option={option} height={height} onBrushEnd={onSelectRange} ariaLabel={panel.description} />
        ) : (
          <BlankChart height={height} reason="No observations in this window." ariaLabel={panel.title} />
        )}

        {showProvenance && (
          <div style={{ borderTop: '1px dashed var(--line-strong)', paddingTop: 12 }}>
            <PanelProvenance panel={panel} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Spec 4.2: the full list of fields that must be reachable wherever a number is
 * displayed. Rendered as one component so no screen can ship a partial version.
 */
export function PanelProvenance({ panel }: { panel: FixturePanel }) {
  const result = db.resultFor(panel.metricIds);
  const src = result.source;
  const metricDefs = panel.metricIds.map((id) => db.metric(id)).filter(Boolean);

  return (
    <div className="col gap4">
      <KeyValues
        rows={[
          { k: 'Measures', v: metricDefs.map((m) => <div key={m!.id} className="mono">{m!.id}</div>) },
          { k: 'Semantic version', v: <span className="mono">{result.query.semanticVersion}</span> },
          {
            k: 'Query hash',
            v: <span className="mono" title={result.query.canonicalQueryHash}>{shortHash(result.query.canonicalQueryHash)}</span>,
          },
          { k: 'Result hash', v: <span className="mono" title={result.resultHash}>{shortHash(result.resultHash)}</span> },
          { k: 'Snapshot', v: <span className="mono">{src.snapshotId}</span> },
          { k: 'Raw manifest', v: <span className="mono" title={src.rawManifestHash}>{shortHash(src.rawManifestHash)}</span> },
          { k: 'Provider', v: db.source(src.sourceId)?.provider ?? src.sourceId },
          { k: 'Grain and timezone', v: `${result.query.grain ?? 'day'} · ${result.query.timezone}` },
          { k: 'Rows', v: <span className="mono">{result.rowCount}</span> },
          { k: 'Coverage', v: <CoverageChip coverage={src.coverage} /> },
          { k: 'Retrieved at', v: <span className="mono">{formatUtc(src.retrievedAt)}</span> },
          { k: 'Source watermark', v: <span className="mono">{formatUtc(src.sourceWatermark)}</span> },
          { k: 'Last successful refresh', v: <span className="mono">{formatUtc(src.lastSuccessfulRefresh)}</span> },
          {
            k: 'Last failed refresh',
            v: src.lastFailedRefresh ? (
              <span className="small">
                <span className="mono">{formatUtc(src.lastFailedRefresh.at)}</span> · {src.lastFailedRefresh.code}
              </span>
            ) : (
              <span className="unavailable" />
            ),
          },
        ]}
      />

      {metricDefs.some((m) => m!.proxyCaveat) && (
        <Notice tone="info" title="What this measure is not">
          {metricDefs.filter((m) => m!.proxyCaveat).map((m) => (
            <div key={m!.id}>{m!.proxyCaveat}</div>
          ))}
        </Notice>
      )}

      {src.visibilityNotes.length > 0 && (
        <Notice tone="warn" title="Visibility limitation">
          {src.visibilityNotes.map((n) => (
            <div key={n}>{n}</div>
          ))}
        </Notice>
      )}

      {metricDefs.some((m) => m!.denominatorPolicy) && (
        <Notice tone="info" title="Missing and unknown values">
          {metricDefs.filter((m) => m!.denominatorPolicy).map((m) => (
            <div key={m!.id}>{m!.denominatorPolicy}</div>
          ))}
        </Notice>
      )}

      <div className="row gap2">
        <Link className="link small" href={`/data/metrics/${panel.metricIds[0]}`}>
          Open measure definition
        </Link>
        <Link className="link small" href={`/data/sources/${src.sourceId}`}>
          Open source
        </Link>
      </div>
    </div>
  );
}

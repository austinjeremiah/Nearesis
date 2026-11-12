'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState, StateBanner, StatePanel } from '@/components/nx/states';
import { Segmented, Skeleton } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';
import { ROW_PX } from '@/lib/panel/edit';
import { usePanelData } from '@/lib/panel/hooks';
import {
  availableViz,
  CERT_LABEL,
  certificationOf,
  coverageInfo,
  dateRuns,
  freshnessInfo,
  truncationInfo,
  truncationLabel,
  type Viz,
} from '@/lib/panel/model';
import type { CanvasMarker, CanvasPanel, PanelData, PanelProgress } from '@/lib/panel/types';
import { ChartRenderer, DataTable } from './ChartRenderer';
import './panel.css';

const VIZ_LABEL: Record<Viz, string> = { line: 'Line', area: 'Area', bar: 'Bar', stacked: 'Stacked', pie: 'Pie', scatter: 'Scatter', candlestick: 'Candles', heatmap: 'Heatmap', table: 'Table', note: 'Note', unsupported: 'Unsupported' };

/** Fetch a panel's data only once it is near the viewport, so a canvas of 100 panels does not stampede the API. */
export function useNearViewport(disabled = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(disabled);
  useEffect(() => {
    if (disabled || near) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setNear(true);
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && (setNear(true), io.disconnect()), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [disabled, near]);
  return { ref, near };
}

/** Compact one-line statements about the data: partial days, truncation, freshness. */
export function PanelNotices({ data, compact }: { data: PanelData; compact?: boolean }) {
  const fr = freshnessInfo(data);
  const trunc = truncationInfo(data);
  const cov = coverageInfo(data);
  const warn = data.chart?.freshnessWarning;
  const unknownDays = cov.missing.length;
  const partialDays = cov.incomplete.length;
  return (
    <div className="nxp-banners">
      {(data.state === 'stale' || warn) && (
        <StateBanner
          state="stale"
          detail={
            <>
              {warn ? `${warn.message} ` : ''}
              {warn?.asOf ? `Showing the last finalized data as of ${formatUtc(warn.asOf)}. ` : ''}
              Not publishable as current.
            </>
          }
        />
      )}
      {trunc && (
        <div data-testid="truncation-label" className="small">
          <Badge tone="warn">Truncated</Badge> {truncationLabel(trunc)}
        </div>
      )}
      {fr.detail && (
        <div className="small" data-testid="rollup-lag">
          <Badge tone="warn">Rollup lag</Badge> {fr.detail}
        </div>
      )}
      {(unknownDays > 0 || partialDays > 0 || (cov.state === 'partial' && cov.note)) && (
        <div className="small" data-testid="coverage-note">
          <Badge tone="warn">Partial coverage</Badge>{' '}
          {unknownDays > 0 && <span>{unknownDays} day{unknownDays === 1 ? '' : 's'} have no coverage record (unknown, not zero){compact ? '' : `: ${dateRuns(cov.missing).slice(0, 6).map(([a, z]) => (a === z ? a : `${a} to ${z}`)).join(', ')}`}. </span>}
          {partialDays > 0 && <span>{partialDays} {data.kind === 'analytics' ? 'incomplete day' : 'partial point'}{partialDays === 1 ? '' : 's'}: counts there are lower bounds. </span>}
          {unknownDays === 0 && partialDays === 0 && cov.note}
        </div>
      )}
      {data.exploratory && data.metricStatus && (
        <div className="small">
          <Badge tone="warn">Exploratory</Badge> Metric status is {data.metricStatus}. It cannot back a published claim.
        </div>
      )}
    </div>
  );
}

export function CertBadge({ panel, data }: { panel: CanvasPanel; data?: PanelData }) {
  const cert = certificationOf(panel, data);
  return (
    <span className="nxp-cert" data-testid="cert-label" data-cert={cert}>
      <Badge tone={cert === 'certified' ? 'ok' : cert === 'analytics' ? 'info' : cert === 'exploratory' ? 'warn' : ''}>{CERT_LABEL[cert]}</Badge>
    </span>
  );
}

export function PanelFooter({ panel, data }: { panel: CanvasPanel; data: PanelData }) {
  const fr = freshnessInfo(data);
  const w = data.chart?.sourceWatermark ?? data.freshness.sourceWatermark;
  return (
    <>
      <CertBadge panel={panel} data={data} />
      {data.provenance && <Badge outline title="Source label">{data.provenance.sourceLabel}</Badge>}
      <Badge tone={fr.tone} title={fr.detail ?? undefined}>{fr.label}</Badge>
      <span className="tiny dim" title="Source watermark">{w ? `as of ${formatUtc(w)}` : 'watermark unknown'}</span>
      {data.provenance && (
        <span className="tiny dim mono" title={`Result hash ${data.provenance.resultHash}`}>
          v{data.provenance.semanticVersion}
        </span>
      )}
    </>
  );
}

/**
 * The data side of a panel: skeleton while querying, the typed state for
 * refusals and CANNOT_COMPUTE (never a chart), banners for non-blocking states, and
 * the chart or table otherwise.
 */
export function PanelBody({
  wid,
  panel,
  height,
  enabled = true,
  progress,
  markers,
  window: win,
  brush,
  viz: vizProp,
  onViz,
  showViz = true,
}: {
  wid: string;
  panel: CanvasPanel;
  height: number;
  enabled?: boolean;
  progress?: { status: PanelProgress; reason?: string };
  markers?: CanvasMarker[];
  window?: { start: string; end: string } | null;
  brush?: boolean;
  viz?: Viz;
  onViz?: (v: Viz) => void;
  showViz?: boolean;
}) {
  const hash = panel.queryRef?.hash;
  const q = usePanelData(wid, hash, enabled && panel.kind !== 'note' && panel.kind !== 'evidenceGraph');
  const data = q.data;
  const vizList = useMemo(() => availableViz(panel, data), [panel, data]);
  const [local, setLocal] = useState<Viz | null>(null);
  const viz = vizProp && vizList.includes(vizProp) ? vizProp : local && vizList.includes(local) ? local : vizList[0];

  if (panel.kind === 'note') return <div className="nxp-body"><div className="nxp-note">{panel.note ?? 'Empty note.'}</div></div>;
  if (panel.kind === 'evidenceGraph')
    return (
      <div className="nxp-body small">
        This panel is the evidence graph. <Link className="link" href={`/w/${wid}/evidence`}>Open the evidence graph</Link>.
      </div>
    );
  if (!hash) return <div className="nxp-body"><StatePanel state="insufficient_data" detail="This panel has no stored query." /></div>;

  const querying = progress?.status === 'QUERYING';
  if (querying || (q.isPending && enabled) || (!enabled && !data)) {
    return (
      <div className="nxp-body" data-testid="panel-skeleton" data-progress={querying ? 'querying' : 'loading'}>
        <div className="nxp-skel" style={{ ['--h' as string]: `${height}px` }} role="status">
          {querying ? 'Querying' : enabled ? 'Loading' : ' '}
        </div>
      </div>
    );
  }
  if (progress?.status === 'ERROR' && !data) {
    return (
      <div className="nxp-body">
        <StatePanel state="source_unavailable" detail={`The query failed${progress.reason ? ` (${progress.reason})` : ''}. The panel stays on the canvas; nothing was substituted.`} onRetry={() => q.refetch()} />
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="nxp-body">
        <ApiErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  }
  if (!data) return <Skeleton rows={3} />;

  // CANNOT_COMPUTE and every blocking state: say what is missing, never draw a chart.
  if (data.cannotCompute || !data.chart || data.state === 'insufficient_data') {
    const cc = data.cannotCompute;
    return (
      <div className="nxp-body" data-testid="cannot-compute">
        <StatePanel
          state={data.state === 'complete' || data.state === 'partial' ? 'insufficient_data' : data.state}
          detail={
            cc ? (
              <>
                <span className="mono">CANNOT_COMPUTE</span> {cc.explanation}
                {cc.missing.length > 0 && (
                  <>
                    {' '}Missing: {cc.missing.join(', ')}.
                  </>
                )}
              </>
            ) : undefined
          }
          onRetry={() => q.refetch()}
        />
      </div>
    );
  }

  return (
    <>
      <PanelNotices data={data} compact />
      <div className="nxp-body" data-testid="panel-data" data-state={data.state} data-kind={data.kind}>
        {showViz && vizList.length > 1 && (
          <div style={{ marginBottom: 4 }}>
            <Segmented
              ariaLabel={`View of ${panel.title}`}
              value={viz}
              options={vizList.map((v) => ({ value: v, label: VIZ_LABEL[v] }))}
              onChange={(v) => (onViz ? onViz(v) : setLocal(v))}
            />
          </div>
        )}
        {viz === 'table' ? <DataTable data={data} limit={height > 400 ? 1000 : 200} /> : <ChartRenderer wid={wid} panel={panel} data={data} viz={viz} height={height} markers={markers} window={win} brush={brush} />}
      </div>
    </>
  );
}

export function layoutHeight(panel: CanvasPanel) {
  return Math.max(200, Math.min(520, panel.layout.h * ROW_PX));
}

/**
 * One panel on the canvas: title and certification, the data body, and the footer
 * with source, freshness and watermark. `tools` holds edit controls.
 */
export function PanelFrame({
  wid,
  panel,
  enabled = true,
  tools,
  edit,
  dim,
  pending,
  children,
  heading,
}: {
  wid: string;
  panel: CanvasPanel;
  enabled?: boolean;
  tools?: ReactNode;
  edit?: ReactNode;
  dim?: boolean;
  pending?: boolean;
  children: ReactNode;
  heading?: boolean;
}) {
  const H = heading ? 'h2' : 'h3';
  const hasQuery = panel.kind !== 'note' && panel.kind !== 'evidenceGraph';
  const data = usePanelData(wid, panel.queryRef?.hash, enabled && hasQuery).data;
  return (
    <article className="nxp" aria-label={panel.title} data-testid="panel" data-panel-id={panel.panelId} data-kind={panel.kind} data-dim={dim ? 'true' : undefined} data-pending={pending ? 'true' : undefined}>
      <header className="nxp-head">
        <H className="nxp-title">
          <Link href={`/w/${wid}/panels/${panel.panelId}`}>{panel.title}</Link>
        </H>
        <div className="nxp-tools">{tools}</div>
      </header>
      {edit}
      {children}
      {hasQuery && (
        <footer className="nxp-foot">
          {data ? <PanelFooter panel={panel} data={data} /> : <CertBadge panel={panel} />}
        </footer>
      )}
    </article>
  );
}

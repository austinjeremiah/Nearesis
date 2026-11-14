'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/nx/evidence';
import { Menu, type MenuItem } from '@/components/nx/overlays';
import { ApiErrorState, StateBanner, StatePanel } from '@/components/nx/states';
import { IconButton, Skeleton } from '@/components/nx/ui';
import { formatAge, formatUtc, shortHash } from '@/lib/format';
import { ROW_PX } from '@/lib/panel/edit';
import { usePanelData } from '@/lib/panel/hooks';
import {
  availableViz,
  bind,
  CERT_LABEL,
  certificationOf,
  colLabel,
  coverageInfo,
  dateRuns,
  freshnessInfo,
  truncationInfo,
  truncationLabel,
  type Viz,
} from '@/lib/panel/model';
import type { CanvasMarker, CanvasPanel, PanelData, PanelProgress } from '@/lib/panel/types';
import { ChartRenderer, DataTable } from './ChartRenderer';
import { ProvenanceDialog } from './ProvenanceDialog';
import { buildProvenanceView } from '@/lib/panel/provenance';
import './panel.css';

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

/**
 * The footer band: what the numbers are as of, which metric version drew them and the result hash. Mono, quiet, always
 * present, so a screenshot of a panel carries its provenance with it.
 */
export function PanelFooter({ data }: { panel?: CanvasPanel; data: PanelData }) {
  const w = data.chart?.sourceWatermark ?? data.freshness.sourceWatermark;
  return (
    <>
      <span className="mono" title="Source watermark">{w ? `as of ${formatUtc(w)}` : 'watermark unknown'}</span>
      {data.provenance && (
        <>
          <span className="mono" title="Semantic version of the metric">metric v{data.provenance.semanticVersion}</span>
          <span className="mono" title={`Result hash ${data.provenance.resultHash}`}>result {shortHash(data.provenance.resultHash)}</span>
        </>
      )}
    </>
  );
}

/** The viz choice lives on the frame (it is in the card menu); the body only reads it. */
const VizCtx = createContext<{ value: Viz | null; set: (v: Viz) => void } | null>(null);

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
}) {
  const ctx = useContext(VizCtx);
  const hash = panel.queryRef?.hash;
  const q = usePanelData(wid, hash, enabled && panel.kind !== 'note' && panel.kind !== 'evidenceGraph');
  const data = q.data;
  const vizList = useMemo(() => availableViz(panel, data), [panel, data]);
  const [local, setLocal] = useState<Viz | null>(null);
  const pick = vizProp ?? ctx?.value ?? local;
  const viz = pick && vizList.includes(pick) ? pick : vizList[0];
  void onViz;
  void setLocal;

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
      <div className="nxp-body" data-testid="panel-data" data-state={data.state} data-kind={data.kind}>
        {viz === 'table' ? <DataTable data={data} limit={height > 400 ? 1000 : 200} /> : <ChartRenderer wid={wid} panel={panel} data={data} viz={viz} height={height} markers={markers} window={win} brush={brush} />}
      </div>
      <PanelNotices data={data} compact />
    </>
  );
}

export function layoutHeight(panel: CanvasPanel) {
  return Math.max(200, Math.min(520, panel.layout.h * ROW_PX));
}

/** The measures line: the unit of every plotted column, or the column names when no unit is declared. Never invented. */
function measuresLine(panel: CanvasPanel, data: PanelData): string {
  const chart = data.chart;
  if (!chart) return 'unit unknown';
  const ys = bind(panel, data).ys;
  const units = [...new Set(ys.map((y) => chart.columns.find((c) => c.name === y)?.unit).filter((u): u is string => !!u))];
  if (units.length) return units.join(' · ');
  return ys.length ? ys.map(colLabel).join(' · ') : 'unit unknown';
}

const VIZ_VERB: Partial<Record<Viz, string>> = { line: 'line', area: 'area', bar: 'bars', stacked: 'stacked bars', pie: 'pie', scatter: 'scatter', candlestick: 'candles', heatmap: 'heatmap', table: 'table' };

/**
 * One panel: a cream card in the upstream pack-panel design. Title and state badges, a mono measures line with source,
 * freshness and as-of, a hairline, the chart with its legend above the plot, then the note band with the provenance.
 * Everything shown is read from the panel's own data; nothing is filled in. `tools` holds inline edit controls,
 * `menuItems` are extra entries for the "..." menu.
 */
export function PanelFrame({
  wid,
  panel,
  enabled = true,
  tools,
  menuItems,
  edit,
  dim,
  pending,
  children,
  heading,
  viz: vizProp,
  onViz,
}: {
  wid: string;
  panel: CanvasPanel;
  enabled?: boolean;
  tools?: ReactNode;
  menuItems?: MenuItem[];
  edit?: ReactNode;
  dim?: boolean;
  pending?: boolean;
  children: ReactNode;
  heading?: boolean;
  viz?: Viz;
  onViz?: (v: Viz) => void;
}) {
  const H = heading ? 'h2' : 'h3';
  const router = useRouter();
  const hasQuery = panel.kind !== 'note' && panel.kind !== 'evidenceGraph';
  const data = usePanelData(wid, panel.queryRef?.hash, enabled && hasQuery).data;
  const [local, setLocal] = useState<Viz | null>(null);
  const [pvOpen, setPvOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const pv = useMemo(() => (pvOpen && data ? buildProvenanceView(panel, data) : null), [pvOpen, panel, data]);
  const vizList = useMemo(() => availableViz(panel, data), [panel, data]);
  const picked = vizProp ?? local;
  const current = picked && vizList.includes(picked) ? picked : vizList[0];
  const ctx = useMemo(() => ({ value: vizProp ?? local, set: (v: Viz) => (onViz ? onViz(v) : setLocal(v)) }), [vizProp, local, onViz]);
  const w = data ? (data.chart?.sourceWatermark ?? data.freshness.sourceWatermark) : null;
  const fr = data ? freshnessInfo(data) : null;
  const blocked = !!data && (data.cannotCompute || !data.chart || data.state === 'insufficient_data');
  const cov = data ? coverageInfo(data) : null;
  const partial = !!data && !blocked && (data.state === 'partial' || cov?.state === 'partial');
  const items: MenuItem[] = [
    ...(menuItems ?? []),
    // "Query and provenance" opens a popup from the data this card already loaded; a panel with no query (a note) has none, so it opens the page.
    ...(heading
      ? []
      : [
          hasQuery
            ? ({ label: 'Query and provenance', disabledReason: data ? undefined : 'The panel data has not loaded yet.', onSelect: () => setPvOpen(true) } as MenuItem)
            : ({ label: 'Open panel', onSelect: () => router.push(`/w/${wid}/panels/${panel.panelId}`) } as MenuItem),
        ]),
    ...(vizList.length > 1
      ? [{ kind: 'separator' } as MenuItem, ...vizList.map((v) => ({ label: `${v === current ? 'Showing' : 'Show as'} ${VIZ_VERB[v] ?? v}`, disabledReason: v === current ? 'Already drawn this way.' : undefined, onSelect: () => ctx.set(v) }) as MenuItem)]
      : []),
    ...(panel.queryRef?.hash ? [{ kind: 'separator' } as MenuItem, { label: 'Copy query hash', onSelect: () => void navigator.clipboard?.writeText(panel.queryRef!.hash) } as MenuItem] : []),
  ];
  return (
    <VizCtx.Provider value={ctx}>
      <article ref={articleRef} className="card panel nxp" aria-label={panel.title} data-testid="panel" data-panel-id={panel.panelId} data-kind={panel.kind} data-dim={dim ? 'true' : undefined} data-pending={pending ? 'true' : undefined}>
        <header className="card-head">
          <div className="grow col gap1" style={{ minWidth: 0 }}>
            <div className="row gap2 wrap" style={{ minWidth: 0 }}>
              <H className="h3 nxp-title">
                <Link href={`/w/${wid}/panels/${panel.panelId}`}>{panel.title}</Link>
              </H>
              {hasQuery && data && <Badge tone={blocked ? 'bad' : partial ? 'warn' : 'ok'}>{blocked ? 'Cannot compute' : partial ? 'Partial' : 'Ready'}</Badge>}
              {hasQuery && <CertBadge panel={panel} data={data} />}
            </div>
            {hasQuery && data && (
              <div className="row gap2 wrap tiny dim">
                <span className="mono">{measuresLine(panel, data)}</span>
                {data.provenance && <Badge outline title="Source label">{data.provenance.sourceLabel}</Badge>}
                {fr && <Badge outline tone={fr.tone} title={fr.detail ?? undefined}>{fr.label}</Badge>}
                <span className="mono" title={w ? `as of ${formatUtc(w)}` : undefined}>{w ? `as of ${formatAge(w)}` : 'as of unknown'}</span>
              </div>
            )}
          </div>
          <div className="actions">
            {tools}
            <Menu align="end" trigger={<IconButton label={`Panel actions for ${panel.title}`}><MoreHorizontal size={15} /></IconButton>} items={items} />
          </div>
        </header>
        {edit}
        {children}
        {hasQuery && data && (
          <footer className="card-foot nxp-foot">
            <PanelFooter panel={panel} data={data} />
          </footer>
        )}
      </article>
      {pv && (
        <ProvenanceDialog
          open={pvOpen}
          onOpenChange={setPvOpen}
          view={pv}
          pageHref={`/w/${wid}/panels/${panel.panelId}`}
          onCloseAutoFocus={(e) => {
            // Focus goes back to this card's "..." button, which opened the popup.
            e.preventDefault();
            articleRef.current?.querySelector<HTMLElement>('.actions button[aria-label^="Panel actions"]')?.focus();
          }}
        />
      )}
    </VizCtx.Provider>
  );
}

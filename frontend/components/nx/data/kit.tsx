'use client';

import './data.css';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeftRight, ArrowRight, Database, Flame, LayoutDashboard, Network, Quote, Radio, Users } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { browserApi } from '@/lib/api/browser';
import { Badge } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice, Segmented, Skeleton } from '@/components/nx/ui';
import { ApiErrorState, StatePanel } from '@/components/nx/states';
import { formatUtc } from '@/lib/format';
import { fInt, fPct } from '@/lib/data/num';
import { Sparkline } from './charts';

/* ---------------------------------------------------------------------------
   Response shapes, observed on the wire (the analytics routes are typed
   `untyped` in OpenAPI, so these mirror the server's IntentsResult envelope).
   -------------------------------------------------------------------------- */

export type Coverage = {
  dataset?: string;
  source?: string;
  scopeNote?: string;
  window?: { from: string; to: string };
  daysInWindow?: number;
  completeDays?: number;
  incompleteDays?: string[];
  missingDays?: string[];
  swapRows?: number;
  usdUnknownRows?: number;
  usdKnownShare?: string | null;
  eraSplit?: Record<string, number>;
  privateSettlementNote?: string;
};

export type Provenance = {
  source?: string;
  tables?: string[];
  asOf?: string;
  computedAt?: string;
  metricVersion?: string;
  method?: string;
};

export type EnvelopeOk<T> = {
  status: 'OK' | 'PARTIAL' | string;
  metric: string;
  definition: string;
  window?: { from: string; to: string };
  chart?: { kind: string };
  data: T;
  coverage: Coverage | null;
  provenance: Provenance;
  caveats: string[];
};

export type EnvelopeCannot = {
  status: 'CANNOT_COMPUTE';
  metric: string;
  missing?: string[];
  explanation?: string;
  alternative?: unknown;
  [k: string]: unknown;
};

export type Envelope<T> = EnvelopeOk<T> | EnvelopeCannot;

export function isCannot<T>(e: Envelope<T>): e is EnvelopeCannot {
  return e.status === 'CANNOT_COMPUTE';
}

/**
 * One GET through the BFF. Every data page reads the API this way; no value is made up client-side.
 * `opts.refetchMs` turns the query into a live one (paused while the tab is hidden by React Query).
 */
export function useApiGet<T>(path: string, query?: Record<string, string | number | undefined>, enabled = true, opts?: { refetchMs?: number }) {
  return useQuery({
    queryKey: ['data', path, query ?? {}],
    queryFn: ({ signal }) => browserApi.get<T>(path, { query, signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
    refetchInterval: opts?.refetchMs,
  });
}

/* ---------------------------------------------------------------------------
   Live status: a pulse and "updated N s ago". The clock only starts after mount,
   so server and client markup agree. The pulse stops under reduced motion (CSS).
   -------------------------------------------------------------------------- */

function useNow(ms = 1000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function agoText(updatedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - updatedAt) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export function LiveStamp({ updatedAt, fetching, failed, everyMs, compact }: { updatedAt: number; fetching?: boolean; failed?: boolean; everyMs?: number; compact?: boolean }) {
  const now = useNow(1000);
  const has = updatedAt > 0;
  const state = failed ? 'stale' : has ? 'live' : 'wait';
  return (
    <span className={`dx-live ${compact ? 'compact' : ''}`.trim()} data-state={state} data-testid="live-stamp" role="status" aria-live="off">
      <span className={`dx-dot ${state === 'live' ? 'on' : state === 'stale' ? 'warn' : ''} ${fetching ? 'busy' : ''}`.trim()} aria-hidden />
      <span className="dx-live-k">{failed ? 'Refresh failed' : has ? 'Live' : 'Connecting'}</span>
      {has && now !== null && <span className="dx-live-t">updated {agoText(updatedAt, now)}</span>}
      {!compact && everyMs && <span className="dx-live-t dim">refreshes every {Math.round(everyMs / 1000)} s</span>}
    </span>
  );
}

/** Latest successful fetch time across several queries (0 when none has returned). */
export function latestUpdate(qs: { dataUpdatedAt: number }[]): number {
  return qs.reduce((m, q) => Math.max(m, q.dataUpdatedAt || 0), 0);
}

/* ---------------------------------------------------------------------------
   Dashboard parts shared by every page in the data area
   -------------------------------------------------------------------------- */

/** Change versus the previous period. Shown only when the caller has both periods; otherwise it says so. Neutral colour: a change is not a verdict. */
export function Delta({ pct, label }: { pct: number | null | undefined; label: string }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return <span className="dx-delta none" data-testid="delta-none">no prior-period comparison</span>;
  }
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return (
    <span className={`dx-delta ${dir}`} data-testid="delta">
      <span aria-hidden>{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>
      <span className="mono">{pct > 0 ? '+' : ''}{pct.toFixed(1)}%</span>
      <span className="dim">{label}</span>
      <span className="sr-only">{dir === 'up' ? 'higher' : dir === 'down' ? 'lower' : 'unchanged'} than the previous period</span>
    </span>
  );
}

export function StatTile({
  label,
  value,
  note,
  delta,
  spark,
  sparkLabel,
  sparkKind,
  href,
  loading,
  error,
  testId,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  delta?: ReactNode;
  spark?: { x: string; y: string | number | null | undefined }[];
  sparkLabel?: string;
  sparkKind?: 'line' | 'bar';
  href?: string;
  loading?: boolean;
  error?: boolean;
  testId?: string;
}) {
  const body = (
    <>
      <span className="dx-tile-label">{label}</span>
      {loading ? (
        <>
          <span className="skel dx-tile-skel-v" aria-hidden />
          <span className="skel text" style={{ width: '60%' }} aria-hidden />
          <span className="sr-only">Loading {label}</span>
        </>
      ) : (
        <>
          <span className="dx-tile-value">{error ? 'unknown' : value}</span>
          {delta && !error && <span className="dx-tile-delta">{delta}</span>}
          {note && <span className="dx-tile-note">{error ? 'This figure could not be loaded.' : note}</span>}
          {spark && spark.length > 1 && !error && (
            <span className="dx-tile-spark">
              <Sparkline points={spark} ariaLabel={sparkLabel ?? `${label} trend`} kind={sparkKind} />
            </span>
          )}
        </>
      )}
      {href && <ArrowRight className="dx-tile-go" size={14} aria-hidden />}
    </>
  );
  return href ? (
    <Link href={href} className="dx-tile surface" data-surface data-testid={testId} aria-label={loading ? `${label}, loading` : undefined}>
      {body}
    </Link>
  ) : (
    <div className="dx-tile surface" data-surface data-testid={testId}>
      {body}
    </div>
  );
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 | 6 }) {
  return <div className={`dx-stats c${cols}`}>{children}</div>;
}

export function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div className="dx-chart-skel skel" style={{ height }} aria-busy="true">
      <span className="sr-only">Loading chart</span>
    </div>
  );
}

type QState = { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

/** A chart card: title, one line of what is plotted, a link to the detail page, and loading / error / empty states. */
export function ChartCard({
  title,
  subtitle,
  href,
  hrefLabel = 'Open',
  state,
  empty,
  height = 240,
  children,
  footer,
  testId,
}: {
  title: string;
  subtitle?: ReactNode;
  href?: string;
  hrefLabel?: string;
  state: QState;
  empty?: { title: string; body: string } | null;
  height?: number;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="dx-card surface" data-surface data-testid={testId} data-status={state.isPending ? 'loading' : state.isError ? 'error' : empty ? 'empty' : 'ready'}>
      <header className="dx-card-head">
        <div className="dx-card-titles">
          <h2 className="dx-card-title">{title}</h2>
          {subtitle && <p className="dx-card-sub">{subtitle}</p>}
        </div>
        {href && (
          <Link href={href} className="dx-card-link">
            {hrefLabel} <ArrowRight size={13} aria-hidden />
          </Link>
        )}
      </header>
      <div className="dx-card-body">
        {state.isPending ? (
          <ChartSkeleton height={height} />
        ) : state.isError ? (
          <ApiErrorState error={state.error as never} onRetry={() => void state.refetch()} />
        ) : empty ? (
          <EmptyState title={empty.title} body={empty.body} />
        ) : (
          children
        )}
      </div>
      {footer && <footer className="dx-card-foot">{footer}</footer>}
    </section>
  );
}

/** A chart card with no query of its own: the parent already holds the data. */
export function PlotCard({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="dx-card surface" data-surface>
      <header className="dx-card-head">
        <div className="dx-card-titles">
          <h3 className="dx-card-title">{title}</h3>
          {subtitle && <p className="dx-card-sub">{subtitle}</p>}
        </div>
      </header>
      <div className="dx-card-body">{children}</div>
      {footer && <footer className="dx-card-foot">{footer}</footer>}
    </section>
  );
}

/** Description on the left, controls on the right. Used at the top of every sub-page. */
export function Toolbar({ children, controls }: { children?: ReactNode; controls?: ReactNode }) {
  return (
    <div className="dx-toolbar">
      {children && <p className="dx-toolbar-note">{children}</p>}
      {controls && <div className="dx-toolbar-controls">{controls}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Window selector
   -------------------------------------------------------------------------- */

export function useWindow(initial = 30) {
  const [days, setDays] = useState(initial);
  return { days, setDays };
}

export function WindowControl({ days, onChange, options = [7, 14, 30, 90] }: { days: number; onChange: (d: number) => void; options?: number[] }) {
  return (
    <Segmented
      ariaLabel="Window in days"
      value={String(days)}
      options={options.map((d) => ({ value: String(d), label: `${d}d` }))}
      onChange={(v) => onChange(Number(v))}
    />
  );
}

/* ---------------------------------------------------------------------------
   Section navigation across the data area
   -------------------------------------------------------------------------- */

const SECTIONS = [
  { href: '/data', label: 'Overview', Icon: LayoutDashboard },
  { href: '/data/intents', label: 'Intents', Icon: ArrowLeftRight },
  { href: '/data/quotes', label: 'Quotes', Icon: Quote },
  { href: '/data/ecosystem', label: 'Ecosystem', Icon: Network },
  { href: '/data/accounts', label: 'Accounts', Icon: Users },
  { href: '/data/economics', label: 'Economics', Icon: Flame },
  { href: '/data/realtime', label: 'Real-time', Icon: Radio },
  { href: '/data/sources', label: 'Sources', Icon: Database },
];

/** Sticky pill navigation between the data sections. */
export function DataNav() {
  const path = usePathname();
  return (
    <nav className="dx-nav" aria-label="Data sections" data-testid="data-nav">
      <ul>
        {SECTIONS.map((s) => {
          const active = s.href === '/data' ? path === '/data' || path.startsWith('/data/metrics') : path.startsWith(s.href);
          return (
            <li key={s.href}>
              <Link href={s.href} aria-current={active ? 'page' : undefined} className={active ? 'on' : ''}>
                <s.Icon size={14} aria-hidden />
                <span>{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ---------------------------------------------------------------------------
   Evidence footer: coverage, provenance, caveats. Rendered under every number.
   -------------------------------------------------------------------------- */

export function CoverageBadge({ c }: { c: Coverage | null | undefined }) {
  if (!c) return <Badge tone="warn">coverage not reported</Badge>;
  const inc = (c.incompleteDays?.length ?? 0) + (c.missingDays?.length ?? 0);
  if (c.daysInWindow === undefined) return <Badge outline>coverage reported</Badge>;
  return inc === 0 ? (
    <Badge tone="ok">{c.completeDays}/{c.daysInWindow} days complete</Badge>
  ) : (
    <Badge tone="warn">{c.completeDays}/{c.daysInWindow} days complete, {inc} incomplete or missing</Badge>
  );
}

export function Evidence({ env }: { env: EnvelopeOk<unknown> }) {
  const c = env.coverage;
  const p = env.provenance;
  return (
    <details className="evidence" data-testid="evidence" style={{ marginTop: 12 }}>
      <summary className="small dim" style={{ cursor: 'pointer' }}>
        Coverage and provenance
        {p?.asOf ? ` | as of ${p.asOf}` : ''}
        {p?.metricVersion ? ` | ${p.metricVersion}` : ''}
      </summary>
      <div className="col gap2" style={{ marginTop: 8 }}>
        {c && (
          <KeyValues
            rows={[
              ...(c.window ? [{ k: 'Window', v: <span className="mono">{c.window.from} to {c.window.to} (UTC)</span> }] : []),
              ...(c.daysInWindow !== undefined ? [{ k: 'Complete days', v: <span className="mono">{c.completeDays} of {c.daysInWindow}</span> }] : []),
              ...(c.incompleteDays?.length ? [{ k: 'Incomplete days', v: <span className="mono">{c.incompleteDays.join(', ')}</span> }] : []),
              ...(c.missingDays?.length ? [{ k: 'Missing days', v: <span className="mono">{c.missingDays.join(', ')}</span> }] : []),
              ...(c.swapRows !== undefined ? [{ k: 'Swap rows', v: <span className="mono">{fInt(c.swapRows)}</span> }] : []),
              ...(c.usdKnownShare !== undefined ? [{ k: 'USD known share', v: <span className="mono">{fPct(c.usdKnownShare, 3)}</span> }] : []),
              ...(c.eraSplit ? [{ k: 'Era split', v: <span className="mono">{Object.entries(c.eraSplit).map(([k, v]) => `${k}: ${fInt(v)}`).join(' | ')}</span> }] : []),
              ...(c.scopeNote ? [{ k: 'Scope', v: c.scopeNote }] : []),
              ...(c.privateSettlementNote ? [{ k: 'Private settlement', v: c.privateSettlementNote }] : []),
            ]}
          />
        )}
        <KeyValues
          rows={[
            { k: 'Source', v: p?.source ?? '—' },
            ...(p?.tables?.length ? [{ k: 'Tables', v: <span className="mono">{p.tables.join(', ')}</span> }] : []),
            { k: 'Computed', v: <span className="mono">{formatUtc(p?.computedAt ?? null)}</span> },
            { k: 'Method', v: p?.method ?? '—' },
          ]}
        />
      </div>
    </details>
  );
}

export function Caveats({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <ul className="small dim" data-testid="caveats" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
      {items.map((c, i) => (
        <li key={i}>{c}</li>
      ))}
    </ul>
  );
}

/** CANNOT_COMPUTE: never a number, always the reason and what is missing. */
export function CannotCompute({ env }: { env: EnvelopeCannot }) {
  return (
    <div data-testid="cannot-compute" data-metric={env.metric}>
      <StatePanel
        state="insufficient_data"
        detail={
          <>
            {env.explanation && <p style={{ margin: '4px 0' }}>{env.explanation}</p>}
            {env.missing && env.missing.length > 0 && (
              <>
                <div className="strong small">Missing inputs</div>
                <ul style={{ margin: '2px 0', paddingLeft: 18, textAlign: 'left' }}>
                  {env.missing.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        }
      />
    </div>
  );
}

/**
 * A card that loads one analytics envelope and renders it. `children` receives
 * the data and the envelope. Handles loading, API failure, CANNOT_COMPUTE,
 * incomplete coverage and caveats so no section re-implements them.
 */
export function EnvelopeCard<T>({
  title,
  path,
  query,
  id,
  actions,
  children,
  enabled = true,
  empty,
  refetchMs,
}: {
  title: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  id: string;
  refetchMs?: number;
  actions?: ReactNode;
  enabled?: boolean;
  empty?: ReactNode;
  children: (data: T, env: EnvelopeOk<T>) => ReactNode;
}) {
  const q = useApiGet<Envelope<T>>(path, query, enabled, { refetchMs });
  return (
    <Card title={title} actions={<>{refetchMs ? <LiveStamp compact updatedAt={q.dataUpdatedAt} fetching={q.isFetching} failed={q.isError && q.dataUpdatedAt > 0} /> : null}{actions}</>}>
      <div data-testid={`card-${id}`} data-status={q.isPending ? 'loading' : q.isError ? 'error' : (q.data?.status ?? '')}>
        {q.isPending ? (
          <Skeleton rows={4} />
        ) : q.data === undefined ? (
          <ApiErrorState error={q.error as Error} onRetry={() => q.refetch()} />
        ) : isCannot(q.data) ? (
          <CannotCompute env={q.data} />
        ) : (
          <>
            {q.data.status !== 'OK' && (
              <Notice tone="warn" title={`Status ${q.data.status}`}>
                This result is not complete. Read the coverage and caveats below.
              </Notice>
            )}
            {q.data.coverage && ((q.data.coverage.incompleteDays?.length ?? 0) + (q.data.coverage.missingDays?.length ?? 0)) > 0 && (
              <Notice tone="warn" title="Incomplete coverage">
                Days not complete in this window make period totals a lower bound.
              </Notice>
            )}
            <p className="small dim" style={{ margin: '0 0 10px' }}>
              {q.data.definition}
            </p>
            {Array.isArray(q.data.data) && q.data.data.length === 0 ? (
              (empty ?? <EmptyState title="No rows" body="The source returned no rows for this window. Nothing is filled in." />)
            ) : (
              children(q.data.data, q.data)
            )}
            <div className="row gap2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <CoverageBadge c={q.data.coverage} />
              {q.data.provenance?.metricVersion && <Badge outline>{q.data.provenance.metricVersion}</Badge>}
            </div>
            <Caveats items={q.data.caveats} />
            <Evidence env={q.data} />
          </>
        )}
      </div>
    </Card>
  );
}

/** A card for routes that are not the analytics envelope (entities, accounts, realtime, sources). */
export function ApiCard<T>({
  title,
  path,
  query,
  id,
  actions,
  caveats,
  children,
  enabled = true,
  subtitle,
  refetchMs,
}: {
  title: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  id: string;
  refetchMs?: number;
  actions?: ReactNode;
  subtitle?: ReactNode;
  caveats?: (d: T) => string[] | undefined;
  enabled?: boolean;
  children: (d: T) => ReactNode;
}) {
  const q = useApiGet<T>(path, query, enabled, { refetchMs });
  return (
    <Card title={title} subtitle={subtitle} actions={<>{refetchMs ? <LiveStamp compact updatedAt={q.dataUpdatedAt} fetching={q.isFetching} failed={q.isError && q.dataUpdatedAt > 0} /> : null}{actions}</>}>
      <div data-testid={`card-${id}`} data-status={q.isPending ? 'loading' : q.isError ? 'error' : 'ready'}>
        {q.isPending ? (
          <Skeleton rows={4} />
        ) : q.data === undefined ? (
          <ApiErrorState error={q.error as Error} onRetry={() => q.refetch()} />
        ) : (
          <>
            {children(q.data)}
            <Caveats items={caveats?.(q.data)} />
          </>
        )}
      </div>
    </Card>
  );
}

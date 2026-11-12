'use client';

import './data.css';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { browserApi } from '@/lib/api/browser';
import { Badge } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice, Segmented, Skeleton } from '@/components/nx/ui';
import { ApiErrorState, StatePanel } from '@/components/nx/states';
import { formatUtc } from '@/lib/format';
import { fInt, fPct } from '@/lib/data/num';

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

/** One GET through the BFF. Every data page reads the API this way; no value is made up client-side. */
export function useApiGet<T>(path: string, query?: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: ['data', path, query ?? {}],
    queryFn: ({ signal }) => browserApi.get<T>(path, { query, signal }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
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
  { href: '/data', label: 'Metrics' },
  { href: '/data/intents', label: 'Intents' },
  { href: '/data/quotes', label: 'Quotes' },
  { href: '/data/ecosystem', label: 'Ecosystem' },
  { href: '/data/accounts', label: 'Accounts' },
  { href: '/data/economics', label: 'Economics' },
  { href: '/data/realtime', label: 'Real-time' },
  { href: '/data/sources', label: 'Sources' },
];

export function DataNav() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Data sections" data-testid="data-nav" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
      {SECTIONS.map((s) => {
        const active = s.href === '/data' ? path === '/data' || path.startsWith('/data/metrics') : path.startsWith(s.href);
        return (
          <Link key={s.href} href={s.href} role="tab" aria-selected={active} aria-current={active ? 'page' : undefined}>
            {s.label}
          </Link>
        );
      })}
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
}: {
  title: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  id: string;
  actions?: ReactNode;
  enabled?: boolean;
  empty?: ReactNode;
  children: (data: T, env: EnvelopeOk<T>) => ReactNode;
}) {
  const q = useApiGet<Envelope<T>>(path, query, enabled);
  return (
    <Card title={title} actions={actions}>
      <div data-testid={`card-${id}`} data-status={q.isPending ? 'loading' : q.isError ? 'error' : (q.data?.status ?? '')}>
        {q.isPending ? (
          <Skeleton rows={4} />
        ) : q.isError ? (
          <ApiErrorState error={q.error} onRetry={() => q.refetch()} />
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
}: {
  title: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  id: string;
  actions?: ReactNode;
  subtitle?: ReactNode;
  caveats?: (d: T) => string[] | undefined;
  enabled?: boolean;
  children: (d: T) => ReactNode;
}) {
  const q = useApiGet<T>(path, query, enabled);
  return (
    <Card title={title} subtitle={subtitle} actions={actions}>
      <div data-testid={`card-${id}`} data-status={q.isPending ? 'loading' : q.isError ? 'error' : 'ready'}>
        {q.isPending ? (
          <Skeleton rows={4} />
        ) : q.isError ? (
          <ApiErrorState error={q.error} onRetry={() => q.refetch()} />
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

'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Card, KeyValues, Notice, Skeleton } from '@/components/nx/ui';
import { Badge } from '@/components/nx/evidence';
import { DataTable, type Column } from '@/components/nx/table';
import { ApiErrorState } from '@/components/nx/states';
import { shellBrowser } from '@/lib/api/shell-browser';
import type { SourceHealthRow } from '@/lib/api/shell';
import { ApiRequestError } from '@/lib/api/errors';
import { EM_DASH, formatAge, formatUsd, formatUtc } from '@/lib/format';

function tone(state: string) {
  return state === 'fresh' || state === 'live' ? 'ok' : state === 'late' ? 'warn' : 'bad';
}
function lag(s: number | null) {
  if (s === null) return EM_DASH;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

export default function SystemView() {
  const sources = useQuery({ queryKey: ['global', 'sources'], queryFn: () => shellBrowser.sources(), refetchInterval: 30_000 });
  const spend = useQuery({ queryKey: ['global', 'cost'], queryFn: () => shellBrowser.costGlobal(), refetchInterval: 30_000, retry: false });
  const slo = useQuery({ queryKey: ['global', 'slo'], queryFn: () => shellBrowser.opsSlo(), retry: false });

  const cols: Column<SourceHealthRow>[] = [
    { key: 'id', header: 'Source', render: (s) => <span className="mono strong">{s.sourceId}</span> },
    { key: 'state', header: 'State', render: (s) => <Badge tone={tone(s.state)}>{s.state}</Badge> },
    {
      key: 'wm',
      header: 'Watermark',
      render: (s) => (
        <span className="small mono" title={formatUtc(s.watermark)}>
          {s.watermark ? `${formatUtc(s.watermark, false)} (${formatAge(s.watermark)})` : EM_DASH}
        </span>
      ),
    },
    { key: 'lag', header: 'Lag', numeric: true, render: (s) => <span className="mono small">{lag(s.lagSeconds)}</span> },
    {
      key: 'cov',
      header: 'Coverage',
      numeric: true,
      render: (s) => (
        <span className="mono small" title={s.coverageWindow ? `${s.coverageWindow.from} to ${s.coverageWindow.to}` : 'No coverage window recorded'}>
          {s.coveragePct === null ? 'not recorded' : `${s.coveragePct}%`}
        </span>
      ),
    },
    { key: 'gaps', header: 'Gaps', numeric: true, render: (s) => <span className="mono small">{s.gapCount ?? EM_DASH}</span> },
    {
      key: 'err',
      header: 'Recent errors',
      numeric: true,
      render: (s) => <span className="mono small">{s.recentErrors.length}</span>,
    },
    {
      key: 'open',
      header: '',
      render: (s) => (
        <Link className="link small" href={`/data/sources/${encodeURIComponent(s.sourceId)}`}>
          Detail
        </Link>
      ),
    },
  ];

  return (
    <div className="col gap4">
      <Card title="Global model-spend ceiling" subtitle="One USD ceiling across all workspaces. Spend with an unknown price is listed, never counted as zero.">
        <div id="spend" data-testid="spend-card">
          {spend.isError ? (
            spend.error instanceof ApiRequestError && spend.error.kind === 'forbidden' ? (
              <Notice tone="info" title="Owner and admin only">The global ceiling is visible to owners and admins.</Notice>
            ) : (
              <ApiErrorState error={spend.error} onRetry={() => spend.refetch()} />
            )
          ) : !spend.data ? (
            <Skeleton rows={3} />
          ) : (
            <div className="col gap3">
              {spend.data.state !== 'ok' && (
                <Notice tone={spend.data.state === 'warning' ? 'warn' : 'bad'} title={`Spend state: ${spend.data.state}`}>
                  Model calls are refused once the ceiling is reached.
                </Notice>
              )}
              <KeyValues
                rows={[
                  { k: 'Ceiling', v: <span className="mono">{formatUsd(spend.data.ceilingUsd)}</span> },
                  { k: 'Committed', v: <span className="mono" data-testid="committed">{formatUsd(spend.data.committedUsd, 4)} ({(spend.data.fraction * 100).toFixed(1)}%)</span> },
                  { k: 'Settled', v: <span className="mono">{formatUsd(spend.data.settledUsd, 4)}</span> },
                  { k: 'Reserved', v: <span className="mono">{formatUsd(spend.data.reservedUsd, 4)}</span> },
                  { k: 'Recorded outside the ledger', v: <span className="mono">{formatUsd(spend.data.externalUsd, 4)}</span> },
                  { k: 'Remaining', v: <span className="mono">{formatUsd(spend.data.remainingUsd, 4)}</span> },
                  { k: 'Unknown-price entries', v: String(spend.data.unknownPriceEntries) },
                  {
                    k: 'Forecast',
                    v:
                      spend.data.forecast.confidence === 'insufficient_data' ? (
                        <span className="small dim">Insufficient data for a projection (needs recent spend entries).</span>
                      ) : (
                        <span className="small">
                          {spend.data.forecast.label}: {spend.data.forecast.projected30DayUsd === null ? EM_DASH : formatUsd(spend.data.forecast.projected30DayUsd)} over 30 days
                          {spend.data.forecast.projectedExhaustionAt ? `, exhausted ${formatUtc(spend.data.forecast.projectedExhaustionAt)}` : ''}
                        </span>
                      ),
                  },
                  { k: 'As of', v: <span className="mono small">{formatUtc(spend.data.asOf)}</span> },
                ]}
              />
              <details>
                <summary className="small">Forecast assumptions</summary>
                <ul className="small">
                  {spend.data.forecast.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </details>
            </div>
          )}
        </div>
      </Card>

      <Card title="Sources" subtitle="Freshness, lag and coverage as recorded by ingestion.">
        {sources.isError ? (
          <ApiErrorState error={sources.error} onRetry={() => sources.refetch()} />
        ) : (
          <div data-testid="sources-health">
            <DataTable
              caption={`${sources.data?.sources.length ?? 0} sources`}
              columns={cols}
              rows={sources.data?.sources ?? []}
              rowKey={(s) => s.sourceId}
              state={{ status: sources.isPending ? 'loading' : (sources.data?.sources.length ?? 0) === 0 ? 'empty' : 'ready' }}
              empty={{ title: 'No sources recorded', body: 'Ingestion has not recorded a watermark for any source.' }}
            />
          </div>
        )}
      </Card>

      <Card title="Service objectives" subtitle="Error-budget burn from the API's own SLO evaluation.">
        {slo.isError ? (
          slo.error instanceof ApiRequestError && slo.error.kind === 'forbidden' ? (
            <Notice tone="info" title="Restricted">Service objectives are visible to operators.</Notice>
          ) : (
            <ApiErrorState error={slo.error} onRetry={() => slo.refetch()} />
          )
        ) : !slo.data ? (
          <Skeleton rows={3} />
        ) : (
          <ul className="col gap2" data-testid="slos" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {slo.data.slos.map((s) => (
              <li key={s.slo.id} className="row gap2 wrap">
                <Badge tone={s.firing ? 'bad' : 'ok'}>{s.firing ? 'burning' : 'ok'}</Badge>
                <span className="strong small">{s.slo.title}</span>
                <span className="tiny dim">objective {(s.slo.objective * 100).toFixed(1)}% over {s.slo.periodDays} days</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

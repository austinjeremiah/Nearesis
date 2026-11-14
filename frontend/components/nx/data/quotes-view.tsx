'use client';

import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { EmptyState } from '@/components/nx/ui';
import { EnvelopeCard, WindowControl, useWindow } from './kit';
import { fInt, fPct, fDec, fMs } from '@/lib/data/num';
import { formatUtc } from '@/lib/format';

type Row = {
  routeId: string; slots: number; attempts: number; notAttempted: number; availabilityRate: string | null;
  available: number; noRoute: number; errors: number; errorCategories: Record<string, number>; unavailableReasons?: Record<string, number>; rateLimited: number;
  latencyMsP50: string | number | null; latencyMsP95: string | number | null;
  usdImpliedCostBpsP50: string | null; usdImpliedCostBpsP95: string | null;
  latestQuotedEffectiveRate: string | null; latestQuoteAt: string | null;
  signatures: { verified: number; invalid: number; signatureUnverifiable: number };
  providerVersion?: string;
};

export default function QuotesView() {
  const { days, setDays } = useWindow(30);
  return (
    <div className="col gap3" data-testid="quotes-view">
      <div className="row gap3" style={{ justifyContent: 'space-between' }}>
        <p className="small dim" style={{ margin: 0 }}>Dry-quote samples only. Nothing here is an executed swap, and there is no execute or swap control.</p>
        <WindowControl days={days} onChange={setDays} />
      </div>
      <EnvelopeCard<Row[]> id="quotes" empty={<EmptyState title="Not sampled" body="No dry-quote samples exist for this window. Availability is unknown, not 0 percent." />} title="Quote observatory (indicative quotes)" path="/v1/intents/quotes" query={{ days }}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title="Not sampled" body="No dry-quote samples exist for this window. Availability is unknown, not 0 percent." />
          ) : (
            <DataTable<Row>
              caption="Per route"
              rows={rows}
              rowKey={(r) => r.routeId}
              columns={[
                { key: 'r', header: 'Route', render: (r) => <span className="mono">{r.routeId}</span> },
                { key: 'a', header: 'Availability', numeric: true, render: (r) => (r.attempts === 0 ? <Badge outline>Not sampled</Badge> : fPct(r.availabilityRate)) },
                { key: 'n', header: 'Attempts', numeric: true, render: (r) => `${fInt(r.attempts)} / ${fInt(r.slots)} slots` },
                { key: 'nr', header: 'No route', numeric: true, render: (r) => fInt(r.noRoute) },
                { key: 'e', header: 'Errors', numeric: true, render: (r) => (Object.keys(r.errorCategories).length ? Object.entries(r.errorCategories).map(([k, v]) => `${k}: ${v}`).join(', ') : fInt(r.errors)) },
                {
                  key: 'ur',
                  header: 'Unavailable reasons',
                  render: (r) =>
                    r.unavailableReasons && Object.keys(r.unavailableReasons).length ? (
                      <span className="col gap1" data-testid="quote-unavailable-reasons">
                        {Object.entries(r.unavailableReasons).map(([k, v]) => (
                          <span key={k} className="mono small">{k} ({fInt(v)} slots)</span>
                        ))}
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    ),
                },
                { key: 'rl', header: 'Rate limited', numeric: true, render: (r) => fInt(r.rateLimited) },
                { key: 'l', header: 'Latency p50 / p95', numeric: true, render: (r) => `${fMs(r.latencyMsP50)} / ${fMs(r.latencyMsP95)}` },
                { key: 'c', header: 'Cost bps p50 / p95', numeric: true, render: (r) => `${fDec(r.usdImpliedCostBpsP50)} / ${fDec(r.usdImpliedCostBpsP95)}` },
                { key: 'rate', header: 'Latest rate', numeric: true, render: (r) => fDec(r.latestQuotedEffectiveRate, 6) },
                {
                  key: 'sig',
                  header: 'Signature',
                  render: (r) => (
                    <span className="row gap1">
                      <Badge tone="ok">{r.signatures.verified} verified</Badge>
                      {r.signatures.invalid > 0 && <Badge tone="bad">{r.signatures.invalid} invalid</Badge>}
                      {r.signatures.signatureUnverifiable > 0 && <Badge tone="warn">{r.signatures.signatureUnverifiable} unverifiable</Badge>}
                    </span>
                  ),
                },
                { key: 't', header: 'Latest quote', render: (r) => <span className="mono small">{formatUtc(r.latestQuoteAt ? `${r.latestQuoteAt.replace(' ', 'T')}Z` : null)}</span> },
              ]}
            />
          )
        }
      </EnvelopeCard>
    </div>
  );
}

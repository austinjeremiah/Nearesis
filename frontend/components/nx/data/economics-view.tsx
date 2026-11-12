'use client';

import Link from 'next/link';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { EmptyState, Notice } from '@/components/nx/ui';
import { ApiCard } from './kit';
import { fPct } from '@/lib/data/num';
import type { LastHour } from './realtime-view';

type Sources = {
  sources: {
    sourceId: string;
    coverageWindow: { from: string; to: string; days: number } | null;
    datasets: { dataset: string; completeDays: number; partialDays: number; unavailableDays: number; missingDays: number; coveragePct: number }[];
    recentErrors: { dataset: string; reasonCode: string; state: string; from: string; to: string }[];
  }[];
};

const UNIT: Record<string, string> = {
  near_economics_outcomes_daily: 'outcomes in tx; gas burnt in gas; tokens burnt in yoctoNEAR',
  near_economics_conversion_daily: 'transactions in tx; conversion gas in gas; conversion tokens in yoctoNEAR',
  near_economics_gas_price_daily: 'blocks; gas price in yoctoNEAR per gas',
};

/**
 * Gas and fees. Units are never mixed (gas, yoctoNEAR and USD are separate
 * quantities) and USD appears only when a timestamped price accompanies the
 * number. The API serves gas and fee tables only through authored metrics, so
 * this page reports what is loaded and refuses to invent values.
 */
export default function EconomicsView() {
  return (
    <div className="col gap3" data-testid="economics-view">
      <Notice tone="info" title="Units are never mixed">
        Gas (gas units), fees (yoctoNEAR) and USD are distinct quantities. A USD value is shown only with a timestamped price; none is estimated here.
      </Notice>

      <ApiCard<LastHour> id="eco-lasthour" title="Gas burnt in the last hour (real-time, finalized)" path="/v1/realtime/transactions-last-hour" caveats={(d) => (d.caveat ? [d.caveat] : [])}>
        {(d) => (
          <div className="col gap1">
            <div className="h2 mono" data-testid="gas-last-hour">{(Number(d.finalized.gasBurnt) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 1 })} Tgas</div>
            <p className="small dim">
              Chunk-header gas over {d.finalized.minutesCovered} finalized minutes ({d.status === 'OK' ? 'complete hour' : 'lower bound'}), exact in total, shifted one block. USD: not shown, there is no timestamped price on this figure.
            </p>
          </div>
        )}
      </ApiCard>

      <ApiCard<Sources> id="eco-datasets" title="Loaded economics datasets (gas, fees, conversions)" path="/v1/sources">
        {(d) => {
          const bq = d.sources.find((s) => s.sourceId === 'near-bigquery');
          const rows = (bq?.datasets ?? []).filter((x) => x.dataset.startsWith('near_economics_'));
          const errs = (bq?.recentErrors ?? []).filter((e) => e.dataset.startsWith('near_economics_'));
          if (!bq || rows.length === 0)
            return <EmptyState title="No economics datasets loaded" body="The source health report lists no gas or fee dataset. Nothing is shown." />;
          return (
            <div className="col gap3">
              <DataTable
                caption={`Coverage ${bq.coverageWindow ? `${bq.coverageWindow.from} to ${bq.coverageWindow.to}` : ''}`}
                rows={rows}
                rowKey={(r) => r.dataset}
                columns={[
                  { key: 'd', header: 'Dataset', render: (r) => <span className="mono">{r.dataset}</span> },
                  { key: 'u', header: 'Units', render: (r) => <span className="small">{UNIT[r.dataset] ?? '—'}</span> },
                  { key: 'c', header: 'Complete days', numeric: true, render: (r) => r.completeDays },
                  { key: 'm', header: 'Missing days', numeric: true, render: (r) => r.missingDays },
                  { key: 'p', header: 'Coverage', numeric: true, render: (r) => fPct(r.coveragePct / 100) },
                ]}
              />
              {errs.length > 0 && (
                <Notice tone="warn" title="Known quality limits in the loaded window">
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {[...new Map(errs.map((e) => [e.reasonCode, e])).values()].map((e) => (
                      <li key={e.reasonCode}><span className="mono">{e.reasonCode}</span> on {errs.filter((x) => x.reasonCode === e.reasonCode).length} day(s), state {e.state}</li>
                    ))}
                  </ul>
                </Notice>
              )}
            </div>
          );
        }}
      </ApiCard>

      <section className="card" data-testid="economics-cannot-compute">
        <div className="card-body">
          <div className="row gap2"><Badge tone="info">CANNOT_COMPUTE here</Badge></div>
          <p className="small">
            Daily gas, tokens burnt and gas price are stored, but the API exposes them only through authored metrics. There is no published route that returns them for a window, so no figure is shown on this page. Author an exploratory metric over the <span className="mono">near_economics_*</span> tables in a workspace to read them with coverage.
          </p>
          <Link className="link small" href="/data">Open the metric catalogue</Link>
        </div>
      </section>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Band } from '@/components/nx/band';
import { Badge } from '@/components/nx/evidence';
import { DataTable, type Column } from '@/components/nx/table';
import { Tabs } from '@/components/nx/ui';
import { EnvelopeCard, WindowControl, useWindow } from './kit';
import { MatrixHeatmap, SeriesChart, ShareBar } from './charts';
import { fInt, fPct, fPctPoints, fUsd, fMs, toNum } from '@/lib/data/num';

type Tab = 'overview' | 'refunds' | 'flows' | 'assets' | 'unusual' | 'settlement' | 'inventory';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'refunds', label: 'Refunds' },
  { value: 'flows', label: 'Chain flows' },
  { value: 'assets', label: 'Assets and concentration' },
  { value: 'unusual', label: 'Unusual flows' },
  { value: 'settlement', label: 'Settlement and solvers' },
  { value: 'inventory', label: 'Field inventory' },
];

const UNKNOWN_USD = 'Swaps with no USD value are counted separately and never valued at 0.';

type Summary = {
  swaps: number; success: number; refunded: number; failed: number; inFlight: number;
  successRate: string; refundRate: string; failedRate: string;
  settledVolumeUsdKnown: string | null; settledSwapsWithUnknownUsd: number;
  swapsWithUnresolvedChain: number; swapsWithUnmappedAsset: number;
};

function T<R>({ cols, rows, caption, rowKey }: { cols: Column<R>[]; rows: R[]; caption: string; rowKey: (r: R, i: number) => string }) {
  const keyed = rows.map((r, i) => ({ r, k: rowKey(r, i) }));
  return (
    <DataTable
      caption={caption}
      columns={cols.map((c) => ({ ...c, render: (x: { r: R; k: string }) => c.render(x.r) })) as unknown as Column<{ r: R; k: string }>[]}
      rows={keyed}
      rowKey={(x) => x.k}
    />
  );
}

export default function IntentsView() {
  const { days, setDays } = useWindow(30);
  const [tab, setTab] = useState<Tab>('overview');
  const q = { days };
  return (
    <div className="col gap3" data-testid="intents-view">
      <div className="row gap3" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Tabs ariaLabel="Intents analysis" value={tab} options={TABS} onChange={setTab} />
        <WindowControl days={days} onChange={setDays} />
      </div>

      {tab === 'overview' && (
        <>
          <EnvelopeCard<Summary> id="summary" title="Summary" path="/v1/intents/summary" query={q}>
            {(d) => (
              <>
                <Band
                  eyebrow={`Last ${days} days`}
                  lead="NEAR Intents 1Click swaps from the provider Explorer."
                  stats={[
                    { value: fInt(d.swaps), detail: 'swaps in the window', lead: true },
                    { value: fUsd(d.settledVolumeUsdKnown), detail: 'settled volume, known USD only' },
                    { value: fPct(d.successRate), detail: 'success rate over terminal swaps' },
                    { value: fPct(d.refundRate), detail: 'refund rate over terminal swaps' },
                  ]}
                />
                <p className="small" data-testid="usd-unknown" style={{ marginTop: 10 }}>
                  <strong>{fInt(d.settledSwapsWithUnknownUsd)}</strong> successful swaps have no USD value and are excluded from volume (counted, not zeroed).{' '}
                  {fInt(d.swapsWithUnmappedAsset)} swaps involve an unmapped asset; {fInt(d.swapsWithUnresolvedChain)} have an unresolved chain. {UNKNOWN_USD}
                </p>
                <p className="small dim">In flight now: {fInt(d.inFlight)} | failed: {fInt(d.failed)}</p>
              </>
            )}
          </EnvelopeCard>
          <EnvelopeCard<Record<string, string | number>[]> id="trend" title="Daily trend" path="/v1/intents/trend" query={{ ...q, granularity: 'day' }}>
            {(rows) => (
              <div className="col gap3">
                <SeriesChart ariaLabel="Daily swaps" unit="swaps" kind="bar" series={[{ name: 'swaps', points: rows.map((r) => ({ x: String(r.period), y: r.swaps })) }]} />
                <SeriesChart ariaLabel="Daily known USD volume" unit="USD (known)" series={[{ name: 'volume (known USD)', points: rows.map((r) => ({ x: String(r.period), y: r.volumeUsdKnown })) }]} />
                <T
                  caption="Trend by day"
                  rows={rows}
                  rowKey={(r) => String(r.period)}
                  cols={[
                    { key: 'p', header: 'Day (UTC)', render: (r) => <span className="mono">{r.period}</span> },
                    { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                    { key: 'ok', header: 'Success', numeric: true, render: (r) => fInt(r.success) },
                    { key: 'rf', header: 'Refund rate', numeric: true, render: (r) => fPct(r.refundRate) },
                    { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                    { key: 'u', header: 'Unknown USD', numeric: true, render: (r) => fInt(r.swapsWithUnknownUsd) },
                  ]}
                />
              </div>
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ status: string; swaps: number; share: string; volumeUsdKnown: string | null; swapsWithUnknownUsd: number }[]> id="status" title="Terminal status" path="/v1/intents/status" query={q}>
            {(rows) => (
              <T
                caption="Swaps by status"
                rows={rows}
                rowKey={(r) => r.status}
                cols={[
                  { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'SUCCESS' ? 'ok' : r.status === 'REFUNDED' ? 'warn' : r.status === 'FAILED' ? 'bad' : 'info'}>{r.status}</Badge> },
                  { key: 'n', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                  { key: 'sh', header: 'Share', numeric: true, render: (r) => fPct(r.share, 2) },
                  { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                ]}
              />
            )}
          </EnvelopeCard>
        </>
      )}

      {tab === 'refunds' && (
        <>
          <EnvelopeCard<{ originChain: string; destinationChain: string; terminalSwaps: number; success: number; refunded: number; failed: number; refundRate: string; failedRate: string }[]>
            id="refund-rates" title="Refund and failure rates by chain pair" path="/v1/intents/refund-rates" query={{ ...q, minTerminal: 100 }}
          >
            {(rows) => (
              <T
                caption="Refund rate by chain pair (pairs with at least 100 terminal swaps)"
                rows={rows}
                rowKey={(r) => `${r.originChain}-${r.destinationChain}`}
                cols={[
                  { key: 'p', header: 'Route', render: (r) => <span className="mono">{r.originChain} to {r.destinationChain}</span> },
                  { key: 't', header: 'Terminal swaps', numeric: true, render: (r) => fInt(r.terminalSwaps) },
                  { key: 'rf', header: 'Refunded', numeric: true, render: (r) => fInt(r.refunded) },
                  { key: 'rr', header: 'Refund rate', numeric: true, render: (r) => fPct(r.refundRate) },
                  { key: 'fr', header: 'Failed rate', numeric: true, render: (r) => fPct(r.failedRate) },
                ]}
              />
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ reason: string; refunded: number; share: string; refundedUsd: string | null; swapsWithUnknownUsd: number }[]> id="refund-causes" title="Refund causes" path="/v1/intents/refund-causes" query={q}>
            {(rows) => (
              <T
                caption="Refunded swaps by provider reason"
                rows={rows}
                rowKey={(r) => r.reason}
                cols={[
                  { key: 'r', header: 'Provider reason', render: (r) => <span className="mono">{r.reason || '(none)'}</span> },
                  { key: 'n', header: 'Refunded', numeric: true, render: (r) => fInt(r.refunded) },
                  { key: 's', header: 'Share', numeric: true, render: (r) => fPct(r.share, 2) },
                  { key: 'b', header: '', render: (r) => <ShareBar share={r.share} /> },
                  { key: 'u', header: 'USD', numeric: true, render: (r) => fUsd(r.refundedUsd) },
                  { key: 'k', header: 'Unknown USD', numeric: true, render: (r) => fInt(r.swapsWithUnknownUsd) },
                ]}
              />
            )}
          </EnvelopeCard>
        </>
      )}

      {tab === 'flows' && (
        <>
          <EnvelopeCard<{ matrix: { originChain: string; destinationChain: string; swaps: number; volumeUsdKnown: string | null; swapsWithUnknownUsd: number; refundRate: string }[]; net?: unknown }>
            id="chain-flows" title="Chain flows" path="/v1/intents/chain-flows" query={q}
          >
            {(d) => (
              <div className="col gap3">
                <MatrixHeatmap ariaLabel="Swaps by origin and destination chain" cells={d.matrix.map((m) => ({ x: m.destinationChain, y: m.originChain, value: m.swaps }))} />
                <T
                  caption="Origin to destination chain"
                  rows={d.matrix.slice(0, 40)}
                  rowKey={(r) => `${r.originChain}-${r.destinationChain}`}
                  cols={[
                    { key: 'p', header: 'Route', render: (r) => <span className="mono">{r.originChain} to {r.destinationChain}</span> },
                    { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                    { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                    { key: 'u', header: 'Unknown USD', numeric: true, render: (r) => fInt(r.swapsWithUnknownUsd) },
                    { key: 'r', header: 'Refund rate', numeric: true, render: (r) => fPct(r.refundRate) },
                  ]}
                />
                {d.matrix.length > 40 && <p className="small dim">Showing the top 40 of {d.matrix.length} routes in the table; the heatmap shows all.</p>}
              </div>
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ originChain: string; destinationChain: string; swaps: number; previousSwaps: number; swapGrowthPct: string | null; volumeUsdKnown: string | null; volumeGrowthPct: string | null; newPair: boolean; belowMinPrevious: boolean }[]>
            id="pair-growth" title="Chain-pair growth versus the preceding window" path="/v1/intents/chain-pair-growth" query={q}
          >
            {(rows) => (
              <T
                caption="Chain pair growth"
                rows={rows}
                rowKey={(r) => `${r.originChain}-${r.destinationChain}`}
                cols={[
                  { key: 'p', header: 'Route', render: (r) => <span className="mono">{r.originChain} to {r.destinationChain}</span> },
                  { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                  { key: 'ps', header: 'Previous', numeric: true, render: (r) => fInt(r.previousSwaps) },
                  { key: 'g', header: 'Swap growth', numeric: true, render: (r) => (r.newPair ? <Badge tone="info">new pair</Badge> : r.belowMinPrevious ? <Badge outline>base too small</Badge> : fPctPoints(r.swapGrowthPct)) },
                  { key: 'vg', header: 'Volume growth', numeric: true, render: (r) => (r.newPair || r.belowMinPrevious ? '—' : fPctPoints(r.volumeGrowthPct)) },
                ]}
              />
            )}
          </EnvelopeCard>
        </>
      )}

      {tab === 'assets' && (
        <>
          <EnvelopeCard<{ originAsset: string; originChain: string; destinationAsset: string; destinationChain: string; swaps: number; volumeUsdKnown: string | null; swapsWithUnknownUsd: number; avgSizeUsd: string | null; refundRate: string }[]>
            id="asset-pairs" title="Top asset pairs" path="/v1/intents/asset-pairs" query={{ ...q, top: 25 }}
          >
            {(rows) => (
              <T
                caption="Top asset pairs"
                rows={rows}
                rowKey={(r, i) => `${i}-${r.originAsset}-${r.destinationAsset}`}
                cols={[
                  { key: 'o', header: 'Origin', render: (r) => <span className="mono">{r.originAsset} ({r.originChain})</span> },
                  { key: 'd', header: 'Destination', render: (r) => <span className="mono">{r.destinationAsset} ({r.destinationChain})</span> },
                  { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                  { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                  { key: 'a', header: 'Avg size', numeric: true, render: (r) => fUsd(r.avgSizeUsd) },
                  { key: 'r', header: 'Refund rate', numeric: true, render: (r) => fPct(r.refundRate) },
                ]}
              />
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ groups: number; total: string; hhi: string; topNShare: string; top: { key: string; value: string; share: string }[] }>
            id="concentration" title="Concentration (origin asset, by volume)" path="/v1/intents/concentration" query={{ ...q, dimension: 'origin_asset', measure: 'volume' }}
          >
            {(d) => (
              <div className="col gap2">
                <p className="small">
                  {fInt(d.groups)} assets | total known volume {fUsd(d.total)} | HHI <span className="mono">{toNum(d.hhi)?.toFixed(0)}</span> | top-N share {fPct(d.topNShare)}
                </p>
                <T
                  caption="Top origin assets by known USD volume"
                  rows={d.top}
                  rowKey={(r) => r.key}
                  cols={[
                    { key: 'k', header: 'Asset', render: (r) => <span className="mono">{r.key}</span> },
                    { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.value) },
                    { key: 's', header: 'Share', numeric: true, render: (r) => fPct(r.share) },
                    { key: 'b', header: '', render: (r) => <ShareBar share={r.share} /> },
                  ]}
                />
              </div>
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ bucket: string; swaps: number; share: string; volumeUsdKnown: string | null }[]> id="size-buckets" title="Swap size distribution (USD)" path="/v1/intents/size-buckets" query={q}>
            {(rows) => (
              <T
                caption="Size buckets"
                rows={rows}
                rowKey={(r) => r.bucket}
                cols={[
                  { key: 'b', header: 'Bucket (USD)', render: (r) => <span className="mono">{r.bucket}</span> },
                  { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                  { key: 'sh', header: 'Share', numeric: true, render: (r) => fPct(r.share) },
                  { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                ]}
              />
            )}
          </EnvelopeCard>
          <EnvelopeCard<{ referral: string; swaps: number; volumeUsdKnown: string | null; swapsWithUnknownUsd: number }[]> id="referrals" title="Referrers" path="/v1/intents/referrals" query={{ ...q, top: 15 }}>
            {(rows) => (
              <T
                caption="Top referrers"
                rows={rows}
                rowKey={(r, i) => `${i}-${r.referral}`}
                cols={[
                  { key: 'r', header: 'Referral', render: (r) => <span className="mono">{r.referral || '(empty)'}</span> },
                  { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                  { key: 'v', header: 'Volume (known USD)', numeric: true, render: (r) => fUsd(r.volumeUsdKnown) },
                  { key: 'u', header: 'Unknown USD', numeric: true, render: (r) => fInt(r.swapsWithUnknownUsd) },
                ]}
              />
            )}
          </EnvelopeCard>
        </>
      )}

      {tab === 'unusual' && (
        <EnvelopeCard<{ method: { name: string; reference: string; threshold: number }; baselineDaysUsed: number; recentDaysUsed: number; excludedIncompleteDays: string[]; pairsNotScoreable: number; flagged: { pair: string; baselineMedianDailySwaps: number; baselineMad: number; anomalies: { day: string; value: number; baselineMedian: number; score: number; direction: string }[] }[] }>
          id="unusual" title="Unusual flows" path="/v1/intents/unusual-flows" query={q}
        >
          {(d) => (
            <div className="col gap3">
              <p className="small">
                Method <span className="mono">{d.method.name}</span>, threshold {d.method.threshold}. Baseline {d.baselineDaysUsed} days, recent {d.recentDaysUsed} days. {fInt(d.pairsNotScoreable)} pairs could not be scored (baseline too small).
                {d.excludedIncompleteDays.length > 0 && ` Excluded incomplete days: ${d.excludedIncompleteDays.join(', ')}.`}
              </p>
              {d.flagged.length === 0 ? (
                <p className="small" data-testid="no-flags">No pair deviates beyond the threshold in this window.</p>
              ) : (
                <T
                  caption="Flagged chain pairs (a flag is a statistical deviation, not a cause)"
                  rows={d.flagged.flatMap((f) => f.anomalies.map((a) => ({ pair: f.pair, median: f.baselineMedianDailySwaps, ...a })))}
                  rowKey={(r) => `${r.pair}-${r.day}`}
                  cols={[
                    { key: 'p', header: 'Pair', render: (r) => <span className="mono">{r.pair}</span> },
                    { key: 'd', header: 'Day', render: (r) => <span className="mono">{r.day}</span> },
                    { key: 'v', header: 'Swaps', numeric: true, render: (r) => fInt(r.value) },
                    { key: 'm', header: 'Baseline median', numeric: true, render: (r) => fInt(r.median) },
                    { key: 's', header: 'Score', numeric: true, render: (r) => r.score.toFixed(1) },
                    { key: 'dir', header: 'Direction', render: (r) => <Badge tone={r.direction === 'up' ? 'info' : 'warn'}>{r.direction}</Badge> },
                  ]}
                />
              )}
            </div>
          )}
        </EnvelopeCard>
      )}

      {tab === 'settlement' && (
        <>
          <EnvelopeCard<{ originChain: string; swaps: number; measured: number; hashesMissing: number; p50Ms: string | null; p95Ms: string | null }[]> id="settlement" title="Settlement duration by origin chain" path="/v1/intents/settlement-duration" query={q}>
            {(rows) => (
              <div className="col gap2">
                <p className="small" data-testid="settlement-caveat">
                  Durations are measured only for the owner-approved public-era pilot days. Other days are not measured and are never shown as zero; read the caveats below for the exact range.
                </p>
                <T
                  caption="Settlement duration (indicative, measured subset)"
                  rows={rows}
                  rowKey={(r) => r.originChain}
                  cols={[
                    { key: 'c', header: 'Origin chain', render: (r) => <span className="mono">{r.originChain}</span> },
                    { key: 's', header: 'Swaps', numeric: true, render: (r) => fInt(r.swaps) },
                    { key: 'm', header: 'Measured', numeric: true, render: (r) => fInt(r.measured) },
                    { key: 'h', header: 'Hashes missing', numeric: true, render: (r) => fInt(r.hashesMissing) },
                    { key: 'p5', header: 'p50', numeric: true, render: (r) => fMs(r.p50Ms) },
                    { key: 'p9', header: 'p95', numeric: true, render: (r) => fMs(r.p95Ms) },
                  ]}
                />
              </div>
            )}
          </EnvelopeCard>
          <EnvelopeCard<unknown> id="solvers" title="Solver metrics" path="/v1/intents/solver-metrics" query={q}>
            {() => <p className="small">Solver metrics returned data.</p>}
          </EnvelopeCard>
        </>
      )}

      {tab === 'inventory' && (
        <EnvelopeCard<{ concept: string; status: string; source: string; note: string }[]> id="inventory" title="What the Explorer does and does not identify" path="/v1/intents/field-inventory">
          {(rows) => (
            <T
              caption="Field inventory"
              rows={rows}
              rowKey={(r) => r.concept}
              cols={[
                { key: 'c', header: 'Concept', render: (r) => <span className="strong">{r.concept}</span> },
                { key: 's', header: 'Status', render: (r) => <Badge tone={r.status === 'identified' ? 'ok' : r.status === 'derived' ? 'info' : 'warn'}>{r.status.replace(/_/g, ' ')}</Badge> },
                { key: 'src', header: 'Source', render: (r) => <span className="small">{r.source}</span> },
                { key: 'n', header: 'Note', render: (r) => <span className="small dim">{r.note}</span> },
              ]}
            />
          )}
        </EnvelopeCard>
      )}
    </div>
  );
}

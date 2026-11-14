'use client';

import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { Card, EmptyState, KeyValues, Notice, Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { ApiCard, Caveats, WindowControl, useApiGet, useWindow } from './kit';
import { SeriesChart } from './charts';
import { fDec, fInt, fUsd } from '@/lib/data/num';
import { formatUtc } from '@/lib/format';
import type { LastHour } from './realtime-view';
import type { ApiRequestError } from '@/lib/api/errors';

type QualityGap = { dataset: string; state: string; reasonCode: string; days: number; firstDay: string; lastDay: string };
type EcoCoverage = {
  source: string;
  sourceCoverage: { dataset: string; state: string; days: number; firstDay: string; lastDay: string }[];
  qualityGaps: QualityGap[];
  loadedRows: Record<string, number>;
};
type Meta = {
  status: string;
  metric: string;
  window: { from: string; to: string };
  precision: string;
  feeRegime: { basis: string; note: string; protocolVersionBoundary: number; activationVerified: boolean };
  coverage?: EcoCoverage;
  caveats: string[];
  provenance: { tables?: string[]; priceSource?: string; computedAt?: string };
};
type UsdConv = { method: string; source: string; priceUsd: string; priceTimestampUTC: string };
type Day = {
  day: string;
  gasBurnt: string;
  tokensBurntYocto: string;
  tokensBurntNear: string;
  outcomes: string;
  effectiveYoctoPerGas: string | null;
  gasPrice: { blocks: string; minYoctoPerGas: string; maxYoctoPerGas: string; meanYoctoPerGas: string; distinctPrices: string } | null;
  conversion: { txs: string; gasBurnt: string; tokensBurntYocto: string; receiptOnlyGasBurnt: string; receiptOnlyTokensBurntYocto: string; basisNote: string } | null;
  executionIntensity: { gasPerTx: string | null; feeYoctoPerTx: string | null; basis: string } | null;
  usd: string | null;
  usdConversion: UsdConv | null;
  usdUnavailableReason: string | null;
};
type Totals = { days: number; gasBurnt: string; tokensBurntYocto: string; usd: string | null; usdUnavailableReason: string | null; pricedDays: number };
type Receivers = { totalGasBurnt: string; totalTokensBurntYocto: string; top: number; items: { account: string; folded: boolean; gasBurnt: string; tokensBurntYocto: string; feeShareBps: string }[] };
type Percentiles = Meta & { loaded: boolean; unavailableReason?: string; data: unknown[] };

const YOCTO_PER_NEAR = 24;
/** Exact yoctoNEAR decimal string to NEAR, by moving the decimal point (string arithmetic, no float). */
function yoctoToNear(y: string): string {
  const neg = y.startsWith('-');
  const d = neg ? y.slice(1) : y;
  const padded = d.padStart(YOCTO_PER_NEAR + 1, '0');
  const whole = padded.slice(0, -YOCTO_PER_NEAR);
  const frac = padded.slice(-YOCTO_PER_NEAR).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
/** Group the integer part with commas, keep the exact digits. */
function groupDigits(s: string): string {
  const [w, f] = s.split('.');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}
function shortExact(s: string, keep = 6): string {
  const [w, f] = s.split('.');
  return f ? `${groupDigits(w)}.${f.slice(0, keep)}` : groupDigits(w);
}
function bpsToPct(bps: string): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}
function tgas(g: string): string {
  return fDec(Number(g) / 1e12, 1);
}

function useEco<T>(sub: string, days: number, extra?: Record<string, number>) {
  return useApiGet<T>(`/v1/economics/${sub}`, { days, ...extra });
}

function Frame<T>({ q, id, title, children, subtitle }: { q: ReturnType<typeof useApiGet<T>>; id: string; title: string; subtitle?: string; children: (d: T) => React.ReactNode }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div data-testid={`card-${id}`} data-status={q.isPending ? 'loading' : q.isError ? 'error' : 'ready'}>
        {q.isPending ? <Skeleton rows={4} /> : q.isError ? <ApiErrorState error={q.error as ApiRequestError} onRetry={() => q.refetch()} /> : children(q.data)}
      </div>
    </Card>
  );
}

/**
 * Network execution-fee economics from the loaded economics tables. Gas is in gas units, fees in yoctoNEAR (exact
 * decimal strings from the API) and USD only where the API supplies a dated price. This is the gross execution fee,
 * never revenue.
 */
export default function EconomicsView() {
  const { days, setDays } = useWindow(30);
  const daily = useEco<Meta & { data: Day[] }>('daily', days);
  const totals = useEco<Meta & { data: Totals }>('totals', days);
  const recv = useEco<Meta & { data: Receivers }>('receivers', days, { top: 10 });
  const pct = useEco<Percentiles>('percentiles', days);
  const cov = useApiGet<EcoCoverage & { window: { from: string; to: string } }>('/v1/economics/coverage', { days });

  const meta = totals.data ?? daily.data;
  return (
    <div className="col gap3" data-testid="economics-view">
      <div className="row gap3" style={{ justifyContent: 'space-between' }}>
        <p className="small dim" style={{ margin: 0 }}>
          Gross execution fee burnt on NEAR, from the loaded economics tables. Not revenue: no burnt versus reward split is made.
        </p>
        <WindowControl days={days} onChange={setDays} options={[7, 30, 90]} />
      </div>

      {meta && (
        <Notice tone="warn" title="Fee regime">
          <span data-testid="fee-regime">{meta.feeRegime.note}</span>
          <span className="small dim" data-testid="token-precision"> Token precision: {meta.precision}; amounts are exact decimal strings of the stored values.</span>
        </Notice>
      )}

      <ApiCard<LastHour> id="eco-lasthour" title="Gas burnt in the last hour (real-time, finalized)" path="/v1/realtime/transactions-last-hour" caveats={(d) => (d.caveat ? [d.caveat] : [])}>
        {(d) => (
          <div className="col gap1">
            <div className="h2 mono" data-testid="gas-last-hour">{(Number(d.finalized.gasBurnt) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 1 })} Tgas</div>
            <p className="small dim">Chunk-header gas over {d.finalized.minutesCovered} finalized minutes ({d.status === 'OK' ? 'complete hour' : 'lower bound'}). USD: not shown, there is no timestamped price on this figure.</p>
          </div>
        )}
      </ApiCard>

      <Frame q={totals} id="eco-totals" title="Window totals" subtitle={totals.data ? `${totals.data.window.from} to ${totals.data.window.to} (UTC)` : undefined}>
        {(t) => (
          <div className="col gap2">
            <KeyValues
              rows={[
                { k: 'Days', v: <span className="mono" data-testid="eco-days">{fInt(t.data.days)}</span> },
                { k: 'Gas burnt', v: <span className="mono" data-testid="eco-total-gas" title="gas units, exact">{groupDigits(t.data.gasBurnt)} gas</span> },
                { k: 'Tokens burnt', v: <span className="mono" data-testid="eco-total-tokens" title="yoctoNEAR, exact">{groupDigits(t.data.tokensBurntYocto)} yoctoNEAR</span> },
                { k: 'Tokens burnt (NEAR)', v: <span className="mono" data-testid="eco-total-near">{shortExact(yoctoToNear(t.data.tokensBurntYocto), 4)} NEAR</span> },
                {
                  k: 'USD',
                  v: t.data.usd ? (
                    <span data-testid="eco-total-usd" className="col gap1">
                      <span className="mono">{fUsd(t.data.usd, false)}</span>
                      <span className="small dim">Sum of daily fee x same-day CoinGecko NEAR/USD close, priced on {t.data.pricedDays} of {t.data.days} days. Each day carries its own price timestamp below.</span>
                    </span>
                  ) : (
                    <span data-testid="eco-total-usd-unavailable"><Badge tone="warn">not available</Badge> <span className="mono small">{t.data.usdUnavailableReason ?? 'NO_TIMESTAMPED_PRICE'}</span></span>
                  ),
                },
              ]}
            />
            <Caveats items={t.caveats} />
          </div>
        )}
      </Frame>

      <Frame q={daily} id="eco-daily" title="Daily gas burnt, tokens burnt and gas price">
        {(d) =>
          d.data.length === 0 ? (
            <EmptyState title="No days loaded" body="No economics days are loaded for this window. Nothing is filled in." />
          ) : (
            <div className="col gap3">
              <div className="grid-2" style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
                <div>
                  <div className="small strong">Gas burnt (Tgas)</div>
                  <SeriesChart ariaLabel="Gas burnt per day in Tgas" unit="Tgas" kind="bar" series={[{ name: 'Gas burnt', points: d.data.map((x) => ({ x: x.day, y: Number(x.gasBurnt) / 1e12 })) }]} />
                </div>
                <div>
                  <div className="small strong">Tokens burnt (NEAR)</div>
                  <SeriesChart ariaLabel="Tokens burnt per day in NEAR" unit="NEAR" kind="bar" series={[{ name: 'Tokens burnt', points: d.data.map((x) => ({ x: x.day, y: x.tokensBurntNear })) }]} />
                </div>
                <div>
                  <div className="small strong">Gas price (yoctoNEAR per gas)</div>
                  <SeriesChart ariaLabel="Mean gas price per day" unit="yocto/gas" series={[{ name: 'Mean gas price', points: d.data.map((x) => ({ x: x.day, y: x.gasPrice?.meanYoctoPerGas ?? null })) }]} />
                </div>
                <div>
                  <div className="small strong">Execution intensity (Ggas per transaction)</div>
                  <SeriesChart ariaLabel="Gas per transaction per day" unit="Ggas/tx" series={[{ name: 'Gas per tx', points: d.data.map((x) => ({ x: x.day, y: x.executionIntensity?.gasPerTx ? Number(x.executionIntensity.gasPerTx) / 1e9 : null })) }]} />
                </div>
              </div>
              <DataTable<Day>
                caption="Per UTC day (exact values)"
                rows={[...d.data].reverse()}
                rowKey={(r) => r.day}
                columns={[
                  { key: 'd', header: 'Day', render: (r) => <span className="mono">{r.day}</span> },
                  { key: 'g', header: 'Gas burnt (gas)', numeric: true, render: (r) => <span className="mono" data-testid="eco-row-gas">{groupDigits(r.gasBurnt)}</span> },
                  { key: 't', header: 'Tokens burnt (yoctoNEAR)', numeric: true, render: (r) => <span className="mono" data-testid="eco-row-tokens">{groupDigits(r.tokensBurntYocto)}</span> },
                  { key: 'gp', header: 'Gas price (yocto/gas)', numeric: true, render: (r) => (r.gasPrice ? <span className="mono">{groupDigits(r.gasPrice.meanYoctoPerGas)}{r.gasPrice.distinctPrices !== '1' ? ` (${r.gasPrice.distinctPrices} prices)` : ''}</span> : <span className="dim">—</span>) },
                  { key: 'ri', header: 'Receipt-only gas', numeric: true, render: (r) => (r.conversion ? <span className="mono">{groupDigits(r.conversion.receiptOnlyGasBurnt)}</span> : <span className="dim">not loaded</span>) },
                  { key: 'cv', header: 'Conversion gas', numeric: true, render: (r) => (r.conversion ? <span className="mono">{groupDigits(r.conversion.gasBurnt)}</span> : <span className="dim">not loaded</span>) },
                  { key: 'ei', header: 'Gas / tx', numeric: true, render: (r) => (r.executionIntensity?.gasPerTx ? <span className="mono">{tgas(r.executionIntensity.gasPerTx)} Tgas</span> : <span className="dim">—</span>) },
                  {
                    key: 'u',
                    header: 'USD (priced)',
                    render: (r) =>
                      r.usd && r.usdConversion ? (
                        <span className="col gap1" data-testid="eco-row-usd">
                          <span className="mono">{fUsd(r.usd, false)}</span>
                          <span className="small dim">
                            {r.usdConversion.source} close {r.usdConversion.priceUsd.slice(0, 7)} at {formatUtc(r.usdConversion.priceTimestampUTC)}
                          </span>
                        </span>
                      ) : (
                        <span data-testid="eco-row-usd-unavailable" className="mono small">{r.usdUnavailableReason ?? 'NO_TIMESTAMPED_PRICE'}</span>
                      ),
                  },
                ]}
              />
              <p className="small dim" data-testid="eco-conversion-note">
                {d.data.find((x) => x.conversion)?.conversion?.basisNote} Execution intensity: {d.data.find((x) => x.executionIntensity)?.executionIntensity?.basis}
              </p>
            </div>
          )
        }
      </Frame>

      <Frame q={recv} id="eco-receivers" title="Top receivers by gas burnt" subtitle="Receiver accounts of the executed receipts, ranked by gross fee">
        {(r) => (
          <div className="col gap2">
            <DataTable
              caption={`Top ${r.data.top}; folded rows group accounts under the loading threshold`}
              rows={r.data.items}
              rowKey={(x) => x.account}
              columns={[
                { key: 'a', header: 'Receiver', render: (x) => (x.folded ? <span><Badge outline>folded</Badge> below threshold</span> : <span className="mono" data-testid="eco-receiver">{x.account}</span>) },
                { key: 'g', header: 'Gas burnt (gas)', numeric: true, render: (x) => <span className="mono">{groupDigits(x.gasBurnt)}</span> },
                { key: 't', header: 'Tokens burnt (yoctoNEAR)', numeric: true, render: (x) => <span className="mono">{groupDigits(x.tokensBurntYocto)}</span> },
                { key: 's', header: 'Share of fee', numeric: true, render: (x) => bpsToPct(x.feeShareBps) },
              ]}
            />
            <Caveats items={r.caveats.filter((c) => !/FLOAT64|Fee regime|CoinGecko/.test(c))} />
          </div>
        )}
      </Frame>

      <Frame q={pct} id="eco-percentiles" title="Per-transaction percentiles">
        {(p) =>
          p.loaded ? (
            <pre className="mono small" data-testid="eco-percentiles-loaded">{JSON.stringify(p.data, null, 2)}</pre>
          ) : (
            <div data-testid="eco-percentiles-not-loaded">
              <div className="row gap2"><Badge tone="warn">not loaded</Badge><span className="mono small">{p.unavailableReason}</span></div>
              <p className="small dim">{p.caveats[p.caveats.length - 1]}</p>
            </div>
          )
        }
      </Frame>

      <Frame q={cov} id="eco-coverage" title="Coverage and quality gaps">
        {(c) => (
          <div className="col gap3">
            <DataTable
              caption={`${c.window.from} to ${c.window.to}, source ${c.source}`}
              rows={c.sourceCoverage}
              rowKey={(x) => x.dataset}
              columns={[
                { key: 'd', header: 'Dataset', render: (x) => <span className="mono">{x.dataset}</span> },
                { key: 's', header: 'State', render: (x) => <Badge tone={x.state === 'complete' ? 'ok' : 'warn'}>{x.state}</Badge> },
                { key: 'n', header: 'Days', numeric: true, render: (x) => x.days },
                { key: 'r', header: 'Range', render: (x) => <span className="mono small">{x.firstDay} to {x.lastDay}</span> },
              ]}
            />
            {c.qualityGaps.length > 0 && (
              <Notice tone="warn" title="Quality gaps">
                <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="eco-quality-gaps">
                  {c.qualityGaps.map((g) => (
                    <li key={`${g.dataset}-${g.reasonCode}`}><span className="mono">{g.reasonCode}</span> on {g.days} day(s) of {g.dataset} ({g.state})</li>
                  ))}
                </ul>
              </Notice>
            )}
            <p className="small dim">Loaded rows: {Object.entries(c.loadedRows).map(([k, v]) => `${k} ${fInt(v)}`).join(', ')}.</p>
          </div>
        )}
      </Frame>
      {meta?.provenance && (
        <p className="small dim">Computed {formatUtc(meta.provenance.computedAt ?? null)} from {meta.provenance.tables?.join(', ')}; price: {meta.provenance.priceSource}.</p>
      )}
    </div>
  );
}

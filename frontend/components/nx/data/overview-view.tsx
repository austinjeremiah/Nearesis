'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { SeriesChart } from './charts';
import { ChartCard, CoverageBadge, Delta, LiveStamp, StatGrid, StatTile, isCannot, latestUpdate, useApiGet, type Envelope } from './kit';
import { periodChange, tailMean, tailSum } from './series';
import { fCompact, fDec, fInt, fPct, fSeconds, fUsd, toNum } from '@/lib/data/num';
import { formatAge } from '@/lib/format';

/* Response shapes for endpoints this area already calls elsewhere (intents, accounts, economics, realtime views). */
type Summary = { swaps: number; settledVolumeUsdKnown: string | null; settledSwapsWithUnknownUsd: number; successRate: string; refundRate: string; inFlight: number };
type TrendRow = { period: string; swaps: number; volumeUsdKnown: string | null };
type AccountsDaily = {
  coverage: { requestedDays: number; daysWithData: number; missingDays: string[] };
  daily: { date: string; activeAccounts: number; newAccounts: number; returningAccounts: number; organicTransactions: number }[];
};
type EcoDay = { day: string; gasBurnt: string; tokensBurntNear: string };
type EcoDaily = { status: string; data: EcoDay[] };
type Fresh = { collectorState: string; watermark: { height: number; blockTime: string } | null; collectorLagSeconds: number | null };
type Hour = { status: string; finalized: { transactions: number; minutesCovered: number; gasBurnt: string }; window: { minutes: number } };

const SLOW = 60_000;
const FAST = 10_000;
const MID = 30_000;

const SECTIONS = [
  { href: '/data/intents', title: 'Intents', body: 'Swaps, status, refunds, chain flows, assets and settlement.' },
  { href: '/data/quotes', title: 'Quotes', body: 'Dry-quote availability, latency and cost per route.' },
  { href: '/data/ecosystem', title: 'Ecosystem', body: 'Entity registry, mapping coverage and changes.' },
  { href: '/data/accounts', title: 'Accounts', body: 'Daily active accounts, growth, retention, concentration.' },
  { href: '/data/economics', title: 'Economics', body: 'Gas and tokens burnt, gas price and top receivers.' },
  { href: '/data/realtime', title: 'Real-time', body: 'Feed freshness and the last finalized hour.' },
  { href: '/data/sources', title: 'Sources', body: 'Watermarks, coverage and rate limits per source.' },
];

export default function DataOverview() {
  const qc = useQueryClient();
  const sum = useApiGet<Envelope<Summary>>('/v1/intents/summary', { days: 30 }, true, { refetchMs: SLOW });
  const trend = useApiGet<Envelope<TrendRow[]>>('/v1/intents/trend', { days: 90, granularity: 'day' }, true, { refetchMs: SLOW });
  const acc = useApiGet<AccountsDaily>('/v1/accounts/daily', { days: 90 }, true, { refetchMs: SLOW });
  const eco = useApiGet<EcoDaily>('/v1/economics/daily', { days: 90 }, true, { refetchMs: SLOW });
  const fresh = useApiGet<Fresh>('/v1/realtime/freshness', undefined, true, { refetchMs: FAST });
  const hour = useApiGet<Hour>('/v1/realtime/transactions-last-hour', undefined, true, { refetchMs: MID });

  const all = [sum, trend, acc, eco, fresh, hour];
  const fetching = all.some((q) => q.isFetching);
  const failedLive = fresh.isError && fresh.dataUpdatedAt > 0;

  const s = sum.data && !isCannot(sum.data) ? sum.data.data : null;
  const t = trend.data && !isCannot(trend.data) ? trend.data : null;
  const trendRows = t?.data ?? [];
  const excluded = useMemo(() => new Set([...(t?.coverage?.incompleteDays ?? []), ...(t?.coverage?.missingDays ?? [])].map((d) => d.slice(0, 10))), [t]);
  const swapsPts = useMemo(() => trendRows.map((r) => ({ x: r.period, y: r.swaps })), [trendRows]);
  const volPts = useMemo(() => trendRows.map((r) => ({ x: r.period, y: r.volumeUsdKnown })), [trendRows]);
  const a = acc.data ?? null;
  const accExcluded = useMemo(() => new Set((a?.coverage.missingDays ?? []).map((d) => d.slice(0, 10))), [a]);
  const txPts = useMemo(() => (a?.daily ?? []).map((d) => ({ x: d.date, y: d.organicTransactions })), [a]);
  const activePts = useMemo(() => (a?.daily ?? []).map((d) => ({ x: d.date, y: d.activeAccounts })), [a]);
  const newPts = useMemo(() => (a?.daily ?? []).map((d) => ({ x: d.date, y: d.newAccounts })), [a]);
  const ecoRows = eco.data?.data ?? [];
  const feePts = useMemo(() => ecoRows.map((d) => ({ x: d.day, y: d.tokensBurntNear })), [ecoRows]);
  const gasPts = useMemo(() => ecoRows.map((d) => ({ x: d.day, y: toNum(d.gasBurnt) === null ? null : (toNum(d.gasBurnt) as number) / 1e12 })), [ecoRows]);

  const swapsCh = periodChange(swapsPts, 30, excluded);
  const volCh = periodChange(volPts, 30, excluded);
  const txCh = periodChange(txPts, 30, accExcluded);
  const actCh = periodChange(activePts, 30, accExcluded);
  const feeCh = periodChange(feePts, 30);
  const txMean = tailMean(txPts, 30);
  const actMean = tailMean(activePts, 30);
  const feeSum = tailSum(feePts, 30);

  const f = fresh.data;
  const h = hour.data;
  const perMin = h && h.finalized.minutesCovered > 0 ? h.finalized.transactions / h.finalized.minutesCovered : null;
  const tonePill = f?.collectorState === 'live' ? 'ok' : f ? 'warn' : '';

  return (
    <div className="col gap4 dx" data-testid="data-overview" data-no-smooth>
      <div className="dx-hero">
        <div>
          <h2 className="dx-hero-title">NEAR at a glance</h2>
          <p className="dx-hero-sub">Intents activity, base-layer usage and fees from the platform&apos;s loaded sources. Each tile and chart links to its detail page; a value with no data shows as unknown.</p>
        </div>
        <div className="dx-hero-status" data-testid="data-live-status">
          <div className="dx-status-line">
            <LiveStamp updatedAt={latestUpdate(all)} fetching={fetching} failed={failedLive} everyMs={FAST} />
            <button type="button" className="dx-refresh" disabled={fetching} onClick={() => void qc.invalidateQueries({ queryKey: ['data'] })}>
              {fetching ? 'Refreshing' : 'Refresh now'}
            </button>
          </div>
          <div className="dx-status-line small">
            {fresh.isError && !f ? (
              <span className="dim">Block feed status unavailable</span>
            ) : !f ? (
              <span className="dim">Checking the block feed</span>
            ) : (
              <>
                <Badge tone={tonePill}>collector {f.collectorState.replace(/_/g, ' ')}</Badge>
                <span className="mono">block {f.watermark ? `#${fInt(f.watermark.height)}` : 'unknown'}</span>
                <span className="dim">{f.watermark ? formatAge(f.watermark.blockTime) : ''}</span>
                {f.collectorLagSeconds !== null && <span className="dim">lag {fSeconds(f.collectorLagSeconds)}</span>}
              </>
            )}
          </div>
        </div>
      </div>

      <section className="col gap3" aria-label="Headline figures">
        <div className="dx-section-h">
          <h2>NEAR Intents</h2>
          <p>Last 30 days, from the provider Explorer</p>
        </div>
        <StatGrid cols={4}>
          <StatTile
            testId="tile-swaps" href="/data/intents" label="Swaps" loading={sum.isPending} error={sum.isError && !s}
            value={s ? fInt(s.swaps) : 'unknown'}
            delta={<Delta pct={swapsCh?.pct} label="vs prior 30 d" />}
            spark={swapsPts.slice(-30)} sparkKind="bar" sparkLabel="Swaps per day, last 30 days"
            note="Count in the window"
          />
          <StatTile
            testId="tile-volume" href="/data/intents" label="Settled volume" loading={sum.isPending} error={sum.isError && !s}
            value={s ? fUsd(s.settledVolumeUsdKnown) : 'unknown'}
            delta={<Delta pct={volCh?.pct} label="vs prior 30 d" />}
            spark={volPts.slice(-30)} sparkLabel="Known USD volume per day, last 30 days"
            note={s ? `Known USD only; ${fInt(s.settledSwapsWithUnknownUsd)} swaps have no USD value` : undefined}
          />
          <StatTile
            testId="tile-success" href="/data/intents" label="Success rate" loading={sum.isPending} error={sum.isError && !s}
            value={s ? fPct(s.successRate) : 'unknown'}
            note={s ? `Of terminal swaps; refund rate ${fPct(s.refundRate)}` : undefined}
          />
          <StatTile
            testId="tile-inflight" href="/data/intents" label="In flight now" loading={sum.isPending} error={sum.isError && !s}
            value={s ? fInt(s.inFlight) : 'unknown'}
            note="Swaps not yet settled"
          />
        </StatGrid>

        <div className="dx-section-h">
          <h2>NEAR base layer</h2>
          <p>Daily chain data, last 30 days unless stated</p>
        </div>
        <StatGrid cols={4}>
          <StatTile
            testId="tile-tx" href="/data/accounts" label="Transactions / day" loading={acc.isPending} error={acc.isError}
            value={txMean ? fInt(Math.round(txMean.mean)) : 'unknown'}
            delta={<Delta pct={txCh?.pct} label="vs prior 30 d" />}
            spark={txPts.slice(-30)} sparkLabel="Organic transactions per day, last 30 days"
            note={txMean ? `Average over ${txMean.count} days with data, organic` : 'No days with data'}
          />
          <StatTile
            testId="tile-active" href="/data/accounts" label="Active accounts / day" loading={acc.isPending} error={acc.isError}
            value={actMean ? fInt(Math.round(actMean.mean)) : 'unknown'}
            delta={<Delta pct={actCh?.pct} label="vs prior 30 d" />}
            spark={activePts.slice(-30)} sparkLabel="Active accounts per day, last 30 days"
            note="Accounts are not people"
          />
          <StatTile
            testId="tile-fees" href="/data/economics" label="Fees burnt" loading={eco.isPending} error={eco.isError}
            value={feeSum ? `${fCompact(feeSum.sum)} NEAR` : 'unknown'}
            delta={<Delta pct={feeCh?.pct} label="vs prior 30 d" />}
            spark={feePts.slice(-30)} sparkKind="bar" sparkLabel="NEAR burnt per day, last 30 days"
            note={feeSum ? `Gross execution fee over ${feeSum.count} loaded days, not revenue` : 'No days loaded'}
          />
          <StatTile
            testId="tile-lasthour" href="/data/realtime" label="Transactions, last hour" loading={hour.isPending} error={hour.isError && !h}
            value={h && h.finalized.minutesCovered > 0 ? fInt(h.finalized.transactions) : 'unknown'}
            note={h ? `${fInt(h.finalized.minutesCovered)} of ${fInt(h.window.minutes)} finalized minutes${perMin === null ? '' : `; about ${fDec(perMin, 0)} per minute`}${h.status === 'OK' ? '' : ', a lower bound'}` : undefined}
          />
        </StatGrid>
      </section>

      <section className="col gap3" aria-label="Main series">
        <div className="dx-section-h">
          <h2>Main series</h2>
          <p>Daily, last 90 days. A gap is missing data, not zero.</p>
        </div>
        <div className="dx-grid">
          <ChartCard
            testId="chart-swaps" title="Intents swaps per day" subtitle="Swaps counted per UTC day" href="/data/intents" hrefLabel="Intents detail"
            state={trend} empty={t && trendRows.length === 0 ? { title: 'No rows', body: 'The source returned no days. Nothing is filled in.' } : trend.data && isCannot(trend.data) ? { title: 'Cannot compute', body: trend.data.explanation ?? 'The metric cannot be computed from the loaded data.' } : null}
            footer={t ? <CoverageBadge c={t.coverage} /> : null}
          >
            <SeriesChart ariaLabel="NEAR Intents swaps per day, last 90 days" unit="swaps" kind="bar" series={[{ name: 'swaps', points: swapsPts }]} />
          </ChartCard>
          <ChartCard
            testId="chart-volume" title="Intents settled volume per day" subtitle="Known USD only; swaps without a USD value are not valued" href="/data/intents" hrefLabel="Intents detail"
            state={trend} empty={t && trendRows.length === 0 ? { title: 'No rows', body: 'The source returned no days. Nothing is filled in.' } : trend.data && isCannot(trend.data) ? { title: 'Cannot compute', body: trend.data.explanation ?? 'The metric cannot be computed from the loaded data.' } : null}
            footer={t ? <CoverageBadge c={t.coverage} /> : null}
          >
            <SeriesChart ariaLabel="NEAR Intents settled volume in known USD per day, last 90 days" unit="USD (known)" area series={[{ name: 'volume (known USD)', points: volPts }]} />
          </ChartCard>
          <ChartCard
            testId="chart-tx" title="Base-layer transactions per day" subtitle="Organic transactions per UTC day" href="/data/accounts" hrefLabel="Accounts detail"
            state={acc} empty={a && a.daily.length === 0 ? { title: 'No days with data', body: 'No account data exists for this window.' } : null}
            footer={a ? <span>{a.coverage.daysWithData} of {a.coverage.requestedDays} days with data{a.coverage.missingDays.length ? `, ${a.coverage.missingDays.length} missing` : ''}</span> : null}
          >
            <SeriesChart ariaLabel="NEAR organic transactions per day, last 90 days" unit="transactions" area series={[{ name: 'transactions', points: txPts }]} />
          </ChartCard>
          <ChartCard
            testId="chart-accounts" title="Active and new accounts per day" subtitle="Signing accounts; new means first organic transaction seen since the scan start" href="/data/accounts" hrefLabel="Accounts detail"
            state={acc} empty={a && a.daily.length === 0 ? { title: 'No days with data', body: 'No account data exists for this window.' } : null}
            footer={<span>Accounts are not people.</span>}
          >
            <SeriesChart ariaLabel="NEAR active and new accounts per day, last 90 days" unit="accounts" series={[{ name: 'active', points: activePts }, { name: 'new', points: newPts }]} />
          </ChartCard>
          <ChartCard
            testId="chart-fees" title="Fees burnt per day" subtitle="Gross execution fee in NEAR, from loaded economics days" href="/data/economics" hrefLabel="Economics detail"
            state={eco} empty={eco.data && ecoRows.length === 0 ? { title: 'No days loaded', body: 'No economics days are loaded for this window.' } : null}
            footer={<span>Not revenue: no burnt versus reward split is made.</span>}
          >
            <SeriesChart ariaLabel="NEAR burnt in execution fees per day, last 90 days" unit="NEAR" kind="bar" series={[{ name: 'tokens burnt', points: feePts }]} />
          </ChartCard>
          <ChartCard
            testId="chart-gas" title="Gas burnt per day" subtitle="Teragas per UTC day" href="/data/economics" hrefLabel="Economics detail"
            state={eco} empty={eco.data && ecoRows.length === 0 ? { title: 'No days loaded', body: 'No economics days are loaded for this window.' } : null}
            footer={<span>Gas units, not converted to USD.</span>}
          >
            <SeriesChart ariaLabel="NEAR gas burnt per day in teragas, last 90 days" unit="Tgas" area series={[{ name: 'gas burnt', points: gasPts }]} />
          </ChartCard>
        </div>
      </section>

      <section className="col gap3" aria-label="Sections">
        <div className="dx-section-h">
          <h2>Explore by section</h2>
        </div>
        <div className="dx-links">
          {SECTIONS.map((x) => (
            <Link key={x.href} href={x.href} className="dx-link surface" data-surface>
              <strong>{x.title}</strong>
              <span>{x.body}</span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

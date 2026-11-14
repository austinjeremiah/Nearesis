'use client';

import { Badge } from '@/components/nx/evidence';
import { KeyValues, Notice } from '@/components/nx/ui';
import { ApiCard, LiveStamp, StatGrid, StatTile, Toolbar, latestUpdate, useApiGet } from './kit';
import { fInt, fSeconds } from '@/lib/data/num';
import { formatAge, formatUtc } from '@/lib/format';

type Fresh = {
  status: string; provider: string; finality: string; lastObservationTime: string | null; lastIngestionTime: string | null;
  watermark: { height: number; blockHash: string; blockTime: string } | null; collectorLagSeconds: number | null; blocksBehindHead: number | null;
  collectorState: string; heartbeatAgeSeconds: number | null;
  historicalCoverage: { from: string; to: string; skippedHeights: number; forwardOnly: boolean } | null;
  reconciliation: { authority: string; recent: { day?: string; difference?: unknown }[] };
  partialDayWarnings: string[]; dataVintageLimitations: string[];
};
export type LastHour = {
  status: string; window: { from: string; to: string; minutes: number };
  finalized: { transactions: number; receipts: number | null; gasBurnt: string; minutesCovered: number };
  provisional: { transactions: number; minutes: number; note: string };
  missingMinutes: number; caveat?: string; limitations: string[];
};

const stateTone = (s: string) => (s === 'live' ? 'ok' : s === 'catching_up' ? 'warn' : 'bad');

const FAST = 10_000;
const MID = 15_000;

export default function RealtimeView() {
  const fresh = useApiGet<Fresh>('/v1/realtime/freshness', undefined, true, { refetchMs: FAST });
  const hour = useApiGet<LastHour>('/v1/realtime/transactions-last-hour', undefined, true, { refetchMs: MID });
  const f = fresh.data;
  const h = hour.data;
  const perMin = h && h.finalized.minutesCovered > 0 ? h.finalized.transactions / h.finalized.minutesCovered : null;
  return (
    <div className="col gap3 dx" data-testid="realtime-view" data-no-smooth>
      <Toolbar controls={<LiveStamp updatedAt={latestUpdate([fresh, hour])} fetching={fresh.isFetching || hour.isFetching} failed={(fresh.isError && fresh.dataUpdatedAt > 0) || (hour.isError && hour.dataUpdatedAt > 0)} everyMs={FAST} />}>
        Finalized blocks from the collector. The page refreshes itself; figures are as of the last successful read, never carried forward as zero.
      </Toolbar>
      <StatGrid cols={4}>
        <StatTile label="Collector" loading={fresh.isPending} error={fresh.isError && !f} value={f ? f.collectorState.replace(/_/g, ' ') : 'unknown'} note={f ? `${f.provider}, finality ${f.finality}` : undefined} />
        <StatTile label="Last block" loading={fresh.isPending} error={fresh.isError && !f} value={f?.watermark ? `#${fInt(f.watermark.height)}` : 'unknown'} note={f?.watermark ? `Block time ${formatAge(f.watermark.blockTime)}; lag ${fSeconds(f.collectorLagSeconds)}` : undefined} />
        <StatTile label="Transactions, last hour" loading={hour.isPending} error={hour.isError && !h} value={h && h.finalized.minutesCovered > 0 ? fInt(h.finalized.transactions) : 'unknown'} note={h ? `${h.finalized.minutesCovered} of ${h.window.minutes} finalized minutes${h.status === 'OK' ? '' : ', a lower bound'}` : undefined} />
        <StatTile label="Per minute" loading={hour.isPending} error={hour.isError && !h} value={perMin === null ? 'unknown' : fInt(Math.round(perMin))} note="Mean over the finalized minutes covered" />
      </StatGrid>
      <ApiCard<Fresh> id="freshness" title="Feed freshness" path="/v1/realtime/freshness" refetchMs={FAST} caveats={(d) => [...d.partialDayWarnings, ...d.dataVintageLimitations]}>
        {(d) => (
          <div className="col gap2">
            <div className="row gap2">
              <Badge tone={stateTone(d.collectorState)}>collector {d.collectorState}</Badge>
              <Badge outline>{d.provider}</Badge>
              <Badge outline>finality {d.finality}</Badge>
              <Badge tone={d.status === 'OK' ? 'ok' : 'warn'}>{d.status}</Badge>
            </div>
            <KeyValues rows={[
              { k: 'Last block (watermark)', v: d.watermark ? <span className="mono">#{fInt(d.watermark.height)} at {formatUtc(d.watermark.blockTime)}</span> : '—' },
              { k: 'Last observation', v: <span className="mono">{formatUtc(d.lastObservationTime)} ({formatAge(d.lastObservationTime)})</span> },
              { k: 'Collector lag', v: <span className="mono">{fSeconds(d.collectorLagSeconds)}</span> },
              { k: 'Blocks behind head', v: <span className="mono">{fInt(d.blocksBehindHead)}</span> },
              { k: 'Heartbeat age', v: <span className="mono">{fSeconds(d.heartbeatAgeSeconds)}</span> },
              { k: 'Stored history', v: d.historicalCoverage ? <span className="mono">{formatUtc(d.historicalCoverage.from)} to {formatUtc(d.historicalCoverage.to)}{d.historicalCoverage.forwardOnly ? ' (forward-only)' : ''}, skipped heights {d.historicalCoverage.skippedHeights}</span> : '—' },
              { k: 'Reconciliation', v: d.reconciliation.recent.length ? `${d.reconciliation.recent.length} recent differences vs ${d.reconciliation.authority}` : `none yet; ${d.reconciliation.authority} is the historical authority` },
            ]} />
          </div>
        )}
      </ApiCard>
      <ApiCard<LastHour> id="lasthour" title="Transactions in the last hour" path="/v1/realtime/transactions-last-hour" refetchMs={MID} caveats={(d) => [...(d.caveat ? [d.caveat] : []), ...d.limitations]}>
        {(d) => (
          <div className="col gap2">
            {d.status !== 'OK' && (
              <Notice tone="warn" title={`${d.status}: lower bound`}>
                Only {d.finalized.minutesCovered} of {d.window.minutes} final minutes are available ({d.missingMinutes} missing). The figure is a lower bound; missing minutes are not zero-filled.
              </Notice>
            )}
            <div className="grid c2">
              <div data-testid="finalized">
                <div className="label">Finalized</div>
                <div className="h2 mono">{fInt(d.finalized.transactions)}</div>
                <div className="small dim">transactions over {d.finalized.minutesCovered} minutes</div>
                <div className="small mono">
                  gas burnt {(Number(d.finalized.gasBurnt) / 1e12).toLocaleString('en-US', { maximumFractionDigits: 1 })} Tgas
                </div>
                <div className="small dim">Receipts: {d.finalized.receipts === null ? 'not collected (public RPC mode)' : fInt(d.finalized.receipts)}</div>
              </div>
              <div data-testid="provisional">
                <div className="label">Provisional (not in the finalized figure)</div>
                <div className="h2 mono">{fInt(d.provisional.transactions)}</div>
                <div className="small dim">{d.provisional.minutes} open minute(s). {d.provisional.note}</div>
              </div>
            </div>
            <p className="small dim">Window {formatUtc(d.window.from)} to {formatUtc(d.window.to)}. Gas is in gas units and is not converted to USD here: no timestamped price is attached to this figure.</p>
          </div>
        )}
      </ApiCard>
    </div>
  );
}

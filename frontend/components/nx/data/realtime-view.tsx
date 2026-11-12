'use client';

import { Badge } from '@/components/nx/evidence';
import { KeyValues, Notice } from '@/components/nx/ui';
import { ApiCard } from './kit';
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

export default function RealtimeView() {
  return (
    <div className="col gap3" data-testid="realtime-view">
      <ApiCard<Fresh> id="freshness" title="Feed freshness" path="/v1/realtime/freshness" caveats={(d) => [...d.partialDayWarnings, ...d.dataVintageLimitations]}>
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
      <ApiCard<LastHour> id="lasthour" title="Transactions in the last hour" path="/v1/realtime/transactions-last-hour" caveats={(d) => [...(d.caveat ? [d.caveat] : []), ...d.limitations]}>
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

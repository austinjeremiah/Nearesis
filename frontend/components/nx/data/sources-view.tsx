'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/nx/evidence';
import { DataTable } from '@/components/nx/table';
import { EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import { ApiCard, WindowControl } from './kit';
import { fInt, fPct, fSeconds } from '@/lib/data/num';
import { formatAge, formatUtc } from '@/lib/format';

export type RateLimit = { status: string; detail: string; attempts: number; limited: number; windowDays: number; lastAttemptAt: string | null };
export type SourceRow = {
  sourceId: string; state: string; watermark: string | null; lagSeconds: number | null; gapCount: number; coveragePct: number | null;
  coverageWindow: { from: string; to: string; days: number } | null;
  datasets: { dataset: string; completeDays: number; partialDays: number; unavailableDays: number; missingDays: number; coveragePct: number }[];
  recentErrors: { dataset: string; reasonCode: string; state: string; from: string; to: string }[];
  rateLimit: RateLimit | null; rateLimitRecorded?: boolean; schemaVersion: string | null;
};

export const stateTone = (s: string) => (s === 'fresh' || s === 'live' ? 'ok' : s === 'late' || s === 'catching_up' ? 'warn' : 'bad');

export function SourcesList() {
  return (
    <ApiCard<{ sources: SourceRow[]; asOf: string; unavailable?: unknown[] }> id="sources" title="Source health" path="/v1/sources">
      {(d) => (
        <div className="col gap2">
          {d.unavailable && d.unavailable.length > 0 && <Notice tone="warn" title="Some sources could not be read">{JSON.stringify(d.unavailable)}</Notice>}
          <DataTable<SourceRow>
            caption={`Sources as of ${formatUtc(d.asOf)}`}
            rows={d.sources}
            rowKey={(s) => s.sourceId}
            columns={[
              { key: 'id', header: 'Source', render: (s) => <Link className="link strong" href={`/data/sources/${encodeURIComponent(s.sourceId)}`}>{s.sourceId}</Link> },
              { key: 'st', header: 'State', render: (s) => <Badge tone={stateTone(s.state)}>{s.state}</Badge> },
              { key: 'w', header: 'Watermark', render: (s) => <span className="mono small">{formatUtc(s.watermark)}</span> },
              { key: 'l', header: 'Lag', numeric: true, render: (s) => fSeconds(s.lagSeconds) },
              { key: 'g', header: 'Gaps', numeric: true, render: (s) => fInt(s.gapCount) },
              { key: 'c', header: '90-day coverage', numeric: true, render: (s) => (s.coveragePct === null ? 'not tracked' : fPct(s.coveragePct / 100)) },
              { key: 'e', header: 'Recent errors', numeric: true, render: (s) => s.recentErrors.length },
              {
                key: 'rl',
                header: 'Rate limit',
                render: (s) =>
                  s.rateLimit ? (
                    <span className="col gap1" data-testid="source-rate-limit" data-recorded="true" title={s.rateLimit.detail}>
                      <span><Badge tone={s.rateLimit.limited > 0 ? 'warn' : 'ok'}>{s.rateLimit.status.replace(/_/g, ' ')}</Badge></span>
                      <span className="small mono">{fInt(s.rateLimit.limited)} of {fInt(s.rateLimit.attempts)} attempts in {s.rateLimit.windowDays}d</span>
                      <span className="tiny dim">last attempt {formatUtc(s.rateLimit.lastAttemptAt)}</span>
                    </span>
                  ) : (
                    <span className="dim" data-testid="source-rate-limit" data-recorded="false">{s.rateLimitRecorded === false ? 'not recorded by this source' : 'not recorded'}</span>
                  ),
              },
            ]}
          />
          <p className="small dim">Lag is the age of the newest event. Daily-batch sources show a lag of up to a day by design. "Not tracked" means the source keeps no per-dataset coverage ledger.</p>
        </div>
      )}
    </ApiCard>
  );
}

type Health = {
  sourceId: string; windowDays: number;
  watermark: { state: string; newestEventTime: string | null; lastFullScanAt: string | null; gapCount: number; lagSeconds: number | null };
  heatmap: { granularity: 'day' | 'hour'; basis: string; note?: string | null; cells: { day: string; hour: number | null; expected: number; observed: number; coverage: number | null; state: string }[]; weekdayHour: { weekday: number; hour: number; coverage: number | null; hoursSampled: number }[] };
  errors: { events: unknown[]; notAttempted: { reason: string; count: number }[]; byCode: { code: string; count: number; firstSeen: string; lastSeen: string; httpStatus: number | null; lastReason: string }[] };
  rateLimits: { recorded: boolean; basis: string; note: string | null; hourly: { at: string; attempts: number; rateLimited: number }[] };
};

const cls = (state: string) => (state === 'ok' ? 'hm-ok' : state === 'partial' ? 'hm-partial' : state === 'none' || state === 'no_data' ? 'hm-none' : 'hm-gap');

function Heatmap({ h }: { h: Health['heatmap'] }) {
  if (h.cells.length === 0) return <EmptyState title="No coverage cells" body="The source reports no coverage for this window." />;
  const days = [...new Set(h.cells.map((c) => c.day))];
  if (h.granularity === 'day') {
    return (
      <div className="hm" data-testid="heatmap" style={{ gridTemplateColumns: `repeat(${Math.min(days.length, 30)}, minmax(14px, 1fr))` }} role="img" aria-label="Coverage by day">
        {h.cells.map((c) => (
          <div key={c.day} className={`hm-cell ${cls(c.state)}`} title={`${c.day}: ${c.observed}/${c.expected} datasets complete (${c.state})`} />
        ))}
      </div>
    );
  }
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const by = new Map(h.cells.map((c) => [`${c.day}|${c.hour}`, c]));
  return (
    <div data-testid="heatmap" role="img" aria-label="Coverage by day and hour" style={{ overflowX: 'auto' }}>
      <div className="hm" style={{ gridTemplateColumns: `90px repeat(24, minmax(14px, 1fr))` }}>
        <span />
        {hours.map((x) => <span key={x} className="tiny dim" style={{ textAlign: 'center' }}>{x}</span>)}
        {days.map((day) => (
          <div key={day} style={{ display: 'contents' }}>
            <span className="tiny mono">{day}</span>
            {hours.map((x) => {
              const c = by.get(`${day}|${x}`);
              return <div key={x} className={`hm-cell ${c ? cls(c.state) : 'hm-none'}`} title={c ? `${day} ${x}:00: ${c.observed}/${c.expected} (${c.state})` : `${day} ${x}:00: no schedule`} />;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function SourceDetail({ sourceId }: { sourceId: string }) {
  const [days, setDays] = useState(14);
  const id = encodeURIComponent(sourceId);
  return (
    <div className="col gap3" data-testid="source-detail">
      <div className="row" style={{ justifyContent: 'flex-end' }}><WindowControl days={days} onChange={setDays} options={[7, 14, 30, 90]} /></div>
      <ApiCard<Health> id="health" title={`${sourceId}: watermark and coverage`} path={`/v1/sources/${id}/health`} query={{ days }}>
        {(d) => (
          <div className="col gap3">
            <KeyValues rows={[
              { k: 'State', v: <Badge tone={stateTone(d.watermark.state)}>{d.watermark.state}</Badge> },
              { k: 'Watermark (newest event)', v: <span className="mono">{formatUtc(d.watermark.newestEventTime)} ({formatAge(d.watermark.newestEventTime)})</span> },
              { k: 'Lag', v: <span className="mono">{fSeconds(d.watermark.lagSeconds)}</span> },
              { k: 'Last full scan', v: <span className="mono">{formatUtc(d.watermark.lastFullScanAt)}</span> },
              { k: 'Gaps recorded', v: <span className="mono">{fInt(d.watermark.gapCount)}</span> },
            ]} />
            <div>
              <div className="label">Coverage heatmap ({d.heatmap.granularity})</div>
              <Heatmap h={d.heatmap} />
              <p className="small dim">{d.heatmap.basis}. {d.heatmap.note}</p>
              <div className="row gap2 small"><span className="hm-cell hm-ok" style={{ width: 14 }} /> complete <span className="hm-cell hm-partial" style={{ width: 14 }} /> partial <span className="hm-cell hm-gap" style={{ width: 14 }} /> gap</div>
            </div>
          </div>
        )}
      </ApiCard>
      <ApiCard<Health> id="errors" title="Errors and quality gaps" path={`/v1/sources/${id}/health/errors`} query={{ days }}>
        {(d) => (
          <div className="col gap3">
            {d.errors.byCode.length === 0 ? <p className="small" data-testid="no-errors">No errors recorded in this window.</p> : (
              <DataTable caption="Errors by code" rows={d.errors.byCode} rowKey={(e) => e.code} columns={[
                { key: 'c', header: 'Code', render: (e) => <span className="mono">{e.code}</span> },
                { key: 'h', header: 'HTTP', numeric: true, render: (e) => e.httpStatus ?? '—' },
                { key: 'n', header: 'Count', numeric: true, render: (e) => fInt(e.count) },
                { key: 'f', header: 'First seen', render: (e) => <span className="mono small">{formatUtc(e.firstSeen)}</span> },
                { key: 'l', header: 'Last seen', render: (e) => <span className="mono small">{formatUtc(e.lastSeen)}</span> },
                { key: 'r', header: 'Reason', render: (e) => <span className="small dim">{e.lastReason}</span> },
              ]} />
            )}
            {d.errors.notAttempted.length > 0 && (
              <DataTable caption="Scheduled but not attempted" rows={d.errors.notAttempted} rowKey={(e) => e.reason} columns={[
                { key: 'r', header: 'Reason', render: (e) => <span className="mono">{e.reason}</span> },
                { key: 'c', header: 'Slots', numeric: true, render: (e) => fInt(e.count) },
              ]} />
            )}
          </div>
        )}
      </ApiCard>
      <ApiCard<Health> id="ratelimits" title="Rate limits" path={`/v1/sources/${id}/health/rate-limits`} query={{ days }}>
        {(d) =>
          !d.rateLimits.recorded ? (
            <Notice tone="info" title="Not recorded">{d.rateLimits.note ?? 'Ingestion keeps no rate-limit history for this source.'} Absence of rows is not evidence of no limiting.</Notice>
          ) : (
            <div className="col gap2">
              <p className="small dim">{d.rateLimits.basis}</p>
              <DataTable caption="Attempts and rate-limit hits per hour" rows={d.rateLimits.hourly.slice(-48)} rowKey={(r) => r.at} columns={[
                { key: 'a', header: 'Hour (UTC)', render: (r) => <span className="mono small">{formatUtc(r.at)}</span> },
                { key: 'n', header: 'Attempts', numeric: true, render: (r) => fInt(r.attempts) },
                { key: 'l', header: 'Rate limited', numeric: true, render: (r) => fInt(r.rateLimited) },
              ]} />
            </div>
          )
        }
      </ApiCard>
    </div>
  );
}

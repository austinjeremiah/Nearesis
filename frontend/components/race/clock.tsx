'use client';
import { ExternalLink, Skull, Timer } from 'lucide-react';
import { StepList, Pill, type StepState } from '@/components/app/ui';
import { useConfig } from '@/lib/config';
import { useNow } from '@/lib/hooks';
import { clock, countdown, hs, short, toUnix } from '@/lib/format';
import type { Job } from '@/lib/types';

const VALID_S = 120, VOID_MARGIN_S = 45;

export function DeathClock({ job }: { job: Job | null }) {
  const now = useNow(1000);
  const { cfg } = useConfig();
  const i = job?.intent;
  if (!i) return <div className="clock"><Timer size={28} /><div className="col gap-s"><b>No payment yet</b><span className="small muted">The HCS referee picks one winner; only it may create the intent.</span></div></div>;

  const paid = ['PAID', 'DONE', 'REFUNDED'].includes(i.status);
  const dead = ['VOID', 'FAILED', 'REJECTED'].includes(i.status);
  const left = i.deadline - now;
  const voidLeft = i.deadline + VOID_MARGIN_S - now;

  if (paid) {
    const cts = i.consensusTimestamp ?? job?.settled?.cts ?? null;
    return (
      <div className="clock paid">
        <div className="t">PAID</div>
        <div className="col gap-s grow">
          <span>at {clock(toUnix(cts))} · tx <span className="mono">{short(i.txId, 14)}</span> · attempts {i.attempts ?? 1}</span>
          {cfg && cts && <a className="link" href={hs.tx(cfg.hashscan, cts)} target="_blank" rel="noreferrer">Open on HashScan <ExternalLink size={12} /></a>}
          <a className="link" href={`/proof/${i.intentId}`}>Proof →</a>
        </div>
      </div>
    );
  }
  if (dead) {
    return (
      <div className="clock void">
        <Skull size={34} />
        <div className="col gap-s">
          <b>Proven {i.status} — money never moved</b>
          <span className="small">tx <span className="mono">{short(i.txId, 14)}</span> absent from Mirror after deadline + {VOID_MARGIN_S}s → round {(job?.round ?? i.round)} opened</span>
          <a className="link" href={`/proof/${i.intentId}`}>Proof →</a>
        </div>
      </div>
    );
  }
  if (left > 0) {
    return (
      <div className="clock">
        <div className="t">{countdown(left)}</div>
        <div className="col gap-s grow">
          <span className="small">Death clock · tx <span className="mono">{short(i.txId, 14)}</span> {i.status === 'PAYMENT_UNKNOWN' && <Pill tone="warn">UNKNOWN — resending same bytes</Pill>}</span>
          <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, (left / VALID_S) * 100))}%` }} /></div>
        </div>
      </div>
    );
  }
  return (
    <div className="clock">
      <div className="t">{countdown(Math.max(0, voidLeft))}</div>
      <div className="col gap-s grow"><b>Clock dead · proving on Mirror Node</b><span className="small muted">Hedera can no longer accept tx {short(i.txId, 12)}. If Mirror still has nothing at 0:00, it is VOID.</span></div>
    </div>
  );
}

export function JobSteps({ job }: { job: Job | null }) {
  const s = job?.status;
  const order = ['OPEN', 'CLAIMED', 'PAYING', 'PAID', 'DONE'];
  const idx = s ? (s === 'REFUNDED' ? 4 : order.indexOf(s)) : -1;
  const st = (k: number): StepState => (idx > k ? 'done' : idx === k ? (k === 4 ? 'done' : 'active') : 'todo');
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">Job · round {job?.round ?? 0}</span>
        {job?.winner && <Pill tone="neon">winner HCS #{job.winner.seq}</Pill>}
      </div>
      <StepList steps={[
        { label: `Claims on HCS (${job?.claims.length ?? 0})`, state: idx >= 0 ? (idx > 0 ? 'done' : 'active') : 'todo' },
        { label: 'First valid claim wins (referee)', state: st(1) },
        { label: 'One intent · one tx id · 120 s clock', state: st(2) },
        { label: 'Paid on Hedera (Mirror SUCCESS)', state: st(3) },
        { label: s === 'REFUNDED' ? 'Job failed → HTS refund' : 'Transcript + summary delivered', state: s === 'REFUNDED' ? 'error' : st(4) },
      ]} />
      {(job?.history?.length ?? 0) > 0 && (
        <div className="small">Closed rounds: {job!.history!.map((h) => <Pill key={h.round} tone="bad">r{h.round} VOID</Pill>)}</div>
      )}
    </div>
  );
}

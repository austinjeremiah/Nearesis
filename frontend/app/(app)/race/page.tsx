'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crosshair, Download, Play, RotateCcw, Terminal } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { CopyButton, Notice, Pill, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { Lanes } from '@/components/race/lanes';
import { DeathClock, JobSteps } from '@/components/race/clock';
import { AgentsRow } from '@/components/race/agents';
import { Timeline } from '@/components/race/timeline';
import { Chaos } from '@/components/race/chaos';
import { Feed } from '@/components/race/feed';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { ENV } from '@/lib/env';
import { useEvent, type EventType } from '@/lib/events';
import { clock, short } from '@/lib/format';
import { jobKeyOf } from '@/lib/jobkey';
import { useOwner } from '@/lib/session';

const RACE_EVENTS: EventType[] = ['claim.posted', 'claim.won', 'claim.lost', 'intent.created', 'payment.unknown', 'payment.paid', 'payment.void', 'job.done', 'refund.sent', 'counter.update', 'agent.revoked', 'chaos'];

export default function RacePage() {
  return <RequireOwner><AppShell title="Race"><Race /></AppShell></RequireOwner>;
}

function Race() {
  const sp = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const owner = useOwner()!;
  const jobKey = sp.get('job');
  const since = Number(sp.get('since') || 0) || Math.floor(Date.now() / 1000) - 300;
  const [follow, setFollow] = useState(true);
  const [paste, setPaste] = useState('');
  const [loading, setLoading] = useState(false);

  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 15_000 });
  const myAgents = new Set((me.data?.agents ?? []).map((a) => a.agentAddr.toLowerCase()));

  const lock = (j: string, s = Math.floor(Date.now() / 1000) - 5) => router.replace(`/race?job=${j}&since=${s}`);

  // "New race" only moves the counting window to now — make that visible, or the click looks like it did nothing.
  const newRace = () => {
    if (!jobKey) return;
    const s = Math.floor(Date.now() / 1000) - 5;
    lock(jobKey, s);
    qc.invalidateQueries({ queryKey: ['race'] });
    toast.success(`New race: counting payments from ${clock(s)}`, { description: 'Now run pnpm baseline, then pnpm agents 3.' });
  };

  const loadDemo = async () => {
    if (!cfg) return;
    setLoading(true);
    try {
      const job = await api.demoJob();
      lock(await jobKeyOf(owner.humanHash, cfg.capability, job.inputHash));
    } catch (e) { report(e); } finally { setLoading(false); }
  };

  useEvent(RACE_EVENTS, (e) => {
    if (follow && e.type === 'claim.posted' && e.data.jobKey && e.data.jobKey !== jobKey && myAgents.has(String(e.data.agentAddr).toLowerCase())) {
      lock(e.data.jobKey, since);
    }
    qc.invalidateQueries({ queryKey: ['race'] });
    if (e.type === 'agent.revoked') qc.invalidateQueries({ queryKey: ['me'] });
  });

  const job = useQuery({ queryKey: ['race', 'job', jobKey], queryFn: () => api.job(jobKey!), enabled: !!jobKey, refetchInterval: 3000, refetchIntervalInBackground: true });

  return (
    <div className="col gap-l">
      <div className="card row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
        <div className="col gap-s">
          <div className="eyebrow"><Crosshair size={12} /> Job (same meeting · same human · same capability)</div>
          <div className="row">
            <span className="mono amount md">{jobKey ? short(jobKey, 10) : 'none locked'}</span>
            {jobKey && <CopyButton text={jobKey} small />}
            {job.data && <Pill tone="ink">round {job.data.round}</Pill>}
            {jobKey && <Pill tone="ink">counting since {clock(since)}</Pill>}
            {job.data && <Pill tone={job.data.status === 'DONE' || job.data.status === 'PAID' ? 'ok' : job.data.status === 'REFUNDED' ? 'warn' : 'info'}>{job.data.status}</Pill>}
          </div>
        </div>
        <div className="row wrap">
          {ENV.DEMO_KEY && <button className="btn" onClick={loadDemo} disabled={loading}>{loading ? <Spinner /> : <Download size={16} />} Load demo job</button>}
          {jobKey && <button type="button" className="btn ghost" onClick={newRace} title="Reset the counting window to now"><RotateCcw size={16} /> New race</button>}
          <label className="row small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow live</label>
          <span className="input-wrap" style={{ minWidth: 220 }}>
            <input className="input mono" placeholder="paste jobKey (64 hex)" value={paste} onChange={(e) => setPaste(e.target.value.trim())} />
          </span>
          <button className="btn ghost" disabled={!/^[0-9a-f]{64}$/.test(paste)} onClick={() => lock(paste)}><Play size={16} /> Lock</button>
        </div>
      </div>

      <div className="card row wrap" style={{ gap: 16 }}>
        <span className="eyebrow"><Terminal size={12} /> Operator</span>
        <span className="row"><code className="mono">pnpm baseline</code><CopyButton text="pnpm baseline" small /></span>
        <span className="row"><code className="mono">pnpm agents 3</code><CopyButton text="pnpm agents 3" small /></span>
        <span className="small muted">Real agents run there; this screen only reads Hedera (HCS + Mirror Node).</span>
      </div>

      {!jobKey ? (
        <Notice tone="info">Press <b>Load demo job</b> (or just run <code>pnpm agents 3</code> with Follow live on). The page locks onto the job the moment the first claim lands.</Notice>
      ) : (
        <>
          <Lanes jobKey={jobKey} since={since} />
          <div className="grid2">
            <DeathClock job={job.data ?? null} />
            <JobSteps job={job.data ?? null} />
          </div>
          <AgentsRow job={job.data ?? null} agents={me.data?.agents ?? []} />
          <div className="grid2">
            <Timeline jobKey={jobKey} job={job.data ?? null} agents={me.data?.agents ?? []} />
          </div>
          {ENV.DEMO_KEY && <Chaos jobKey={jobKey} job={job.data ?? null} agents={me.data?.agents ?? []} />}
        </>
      )}
      <Feed />
    </div>
  );
}

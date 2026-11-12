'use client';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, ScrollText } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toUnix } from '@/lib/format';
import type { Agent, Job, TimelineEv } from '@/lib/types';

export function Timeline({ jobKey, job, agents }: { jobKey: string; job: Job | null; agents: Agent[] }) {
  const { cfg } = useConfig();
  const q = useQuery({ queryKey: ['race', 'timeline', jobKey], queryFn: () => api.timeline(jobKey), refetchInterval: 4000, refetchIntervalInBackground: true });
  const label = (addr?: unknown) => (typeof addr === 'string' ? agents.find((a) => a.agentAddr.toLowerCase() === addr.toLowerCase())?.label ?? short(addr) : '');
  const d = cfg?.assetDecimals ?? 6;

  const say = (e: TimelineEv): string => {
    const m = e as Record<string, any>;
    switch (e.t) {
      case 'LINK': return `${label(m.agent)} linked · acct ${m.acct} · epoch ${m.epoch}`;
      case 'REVOKE': return `${label(m.agent)} fired · epoch → ${m.epoch}`;
      case 'CLAIM': return `r${m.round} ${label(m.agent)} claims ${m.svc} @ ${formatToken(m.price, d)}`;
      case 'INTENT': return `r${m.round} intent tx ${short(m.tx, 12)} · dies ${clock(Number(m.dl))}`;
      case 'SETTLED': return `r${m.round} SETTLED tx ${short(m.tx, 12)}`;
      case 'VOID': return `r${m.round} VOID tx ${short(m.tx, 12)} → next round`;
      case 'DONE': return `r${m.round} ${m.svc} delivered · out ${short(m.out, 8)}`;
      case 'REFUND': return `r${m.round} refund ${short(m.rtx, 12)} · ${formatToken(m.amt, d)}`;
      case 'APPROVAL': return `World approval · ${m.kind}`;
      default: return e.t;
    }
  };
  const verdict = (e: TimelineEv) => {
    if (e.t !== 'CLAIM') return null;
    const c = job?.claims.find((x) => x.seq === e.seq);
    if (!c) return null;
    if (job?.winner?.seq === e.seq) return <Pill tone="neon">WINNER</Pill>;
    return c.valid === false ? <Pill tone="bad">{c.reason}</Pill> : <Pill>late</Pill>;
  };
  const rows = [...(q.data?.events ?? [])].sort((a, b) => b.seq - a.seq);

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow"><ScrollText size={12} /> Referee log · Hedera HCS</span>
        {cfg && <a className="link small" href={hs.topic(cfg.hashscan, cfg.topicId)} target="_blank" rel="noreferrer">topic {cfg.topicId} <ExternalLink size={12} /></a>}
      </div>
      <div className="feed">
        <table className="tbl">
          <thead><tr><th>#</th><th>Type</th><th>What</th><th>Referee</th><th>Time</th><th>Payer</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.seq}>
                <td className="mono">{e.seq}</td>
                <td><span className={`chip-t ${e.t}`}>{e.t}</span></td>
                <td className="small">{say(e)}</td>
                <td>{verdict(e)}</td>
                <td className="mono small">{cfg ? <a className="link" href={`${cfg.hashscan}/topic/${cfg.topicId}/message/${e.seq}`} target="_blank" rel="noreferrer">{clock(toUnix(e.cts))}</a> : clock(toUnix(e.cts))}</td>
                <td className="mono small">{e.payer ?? ''}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No HCS messages for this job yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

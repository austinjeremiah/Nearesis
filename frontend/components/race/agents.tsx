'use client';
import { Bot } from 'lucide-react';
import { Pill } from '@/components/app/ui';
import { short } from '@/lib/format';
import type { Agent, Job } from '@/lib/types';

export function AgentsRow({ job, agents }: { job: Job | null; agents: Agent[] }) {
  if (!agents.length) return null;
  return (
    <div className="agents-row">
      {agents.map((a) => {
        const c = job?.claims.find((x) => x.agent.toLowerCase() === a.agentAddr.toLowerCase());
        const won = !!c && job?.winner?.seq === c.seq;
        const cls = a.status === 'REVOKED' ? 'revoked' : won ? 'won' : c ? 'lost' : '';
        return (
          <div key={a.agentAddr} className={`agent ${cls}`}>
            <div className="row"><Bot size={16} /><b>{a.label}</b></div>
            <span className="mono small">{short(a.agentAddr)} · epoch {a.epoch}</span>
            {a.status === 'REVOKED' ? <Pill tone="bad">REVOKED</Pill>
              : !c ? <Pill>idle</Pill>
              : won ? <Pill tone="ink">WON · pays</Pill>
              : c.valid === false ? <Pill tone="bad">invalid: {c.reason}</Pill>
              : <Pill tone="info">LOST · paid by winner</Pill>}
            {c && <span className="small muted">{c.svc} · HCS #{c.seq}</span>}
          </div>
        );
      })}
    </div>
  );
}

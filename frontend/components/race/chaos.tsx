'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Bomb, Repeat, Skull, Wallet } from 'lucide-react';
import { Notice, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { api } from '@/lib/api';
import { useEvent } from '@/lib/events';
import type { Agent, Job } from '@/lib/types';

type Out = { tone: 'ok' | 'bad' | 'info'; title: string; body: string } | null;

export function Chaos({ jobKey, job, agents }: { jobKey: string; job: Job | null; agents: Agent[] }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<Out>(null);
  const revoked = agents.filter((a) => a.status === 'REVOKED');
  const [revAddr, setRevAddr] = useState('');

  useEvent(['chaos'], (e) => toast.message(`Chaos: ${e.data.kind}`, { description: typeof e.data.detail === 'string' ? e.data.detail : JSON.stringify(e.data.detail) }));
  useEvent(['refund.sent'], () => toast.success('Provider refunded the budget in HTS'));
  useEvent(['payment.unknown'], () => toast.warning('Payment UNKNOWN — the death clock decides'));

  const run = async (k: string, f: () => Promise<Out>) => {
    setBusy(k);
    try { setOut(await f()); } catch (e) { report(e); } finally { setBusy(null); }
  };

  const B = ({ k, icon: I, children, disabled, onClick }: { k: string; icon: typeof Bomb; children: React.ReactNode; disabled?: boolean; onClick: () => void }) => (
    <button className="btn ghost" disabled={!!busy || disabled} onClick={onClick}>{busy === k ? <Spinner /> : <I size={16} />} {children}</button>
  );

  return (
    <div className="card col">
      <span className="eyebrow"><Bomb size={12} /> Chaos — break it on stage</span>
      <div className="row wrap">
        <B k="kill" icon={Skull} onClick={() => run('kill', async () => { await api.chaosKill(); return { tone: 'info', title: 'Armed: kill next payer', body: 'Now run pnpm agents 3. The payer aborts 400 ms after sending; the death clock decides PAID or VOID.' }; })}>Kill next payer</B>
        <B k="fail" icon={Ban} onClick={() => run('fail', async () => { await api.chaosFail(); return { tone: 'info', title: 'Armed: fail next job', body: 'The provider takes the payment, fails, and refunds in HTS. Watch the REFUND row.' }; })}>Fail next job</B>
        <B k="replay" icon={Repeat} disabled={!job?.intent} onClick={() => run('replay', async () => {
          const r = await api.chaosReplay(job!.intent!.intentId);
          const reason = r?.facilitator?.errorReason;
          return reason === 'forkos_replay_detected'
            ? { tone: 'ok', title: 'Replay refused', body: `Facilitator: ${reason}. Same signed bytes cannot settle twice.` }
            : { tone: 'bad', title: 'Unexpected replay result', body: JSON.stringify(r) };
        })}>Replay last payment</B>
        <select className="input" style={{ maxWidth: 200 }} value={revAddr} onChange={(e) => setRevAddr(e.target.value)}>
          <option value="">fired agent…</option>
          {revoked.map((a) => <option key={a.agentAddr} value={a.agentAddr}>{a.label}</option>)}
        </select>
        <B k="revive" icon={Ban} disabled={!revAddr} onClick={() => run('revive', async () => {
          const r = await api.chaosRevive(revAddr, jobKey);
          const code = r?.provider?.body?.error?.code;
          return r?.provider?.status === 409
            ? { tone: 'ok', title: 'Fenced out', body: `Provider answered 409 ${code}. A fired agent’s stale epoch cannot buy.` }
            : { tone: 'bad', title: 'Unexpected revive result', body: JSON.stringify(r) };
        })}>Revive fired agent</B>
        <B k="cap" icon={Wallet} onClick={() => run('cap', async () => { await api.putPolicy({ capPerPayment: '10000' }); qc.invalidateQueries({ queryKey: ['me'] }); return { tone: 'info', title: 'Cap = 0.01 FUSD', body: 'Run pnpm agents 1 — the World approval sheet will open here.' }; })}>Cap 0.01</B>
        <B k="cap2" icon={Wallet} onClick={() => run('cap2', async () => { await api.putPolicy({ capPerPayment: '1000000' }); qc.invalidateQueries({ queryKey: ['me'] }); return { tone: 'info', title: 'Cap = 1.00 FUSD', body: 'Back to normal.' }; })}>Cap 1.00</B>
      </div>
      {out && <Notice tone={out.tone}><b>{out.title}.</b> {out.body}</Notice>}
      {revoked.length === 0 && <span className="small muted">To demo “revive”: revoke an agent on the Dashboard first (World approval).</span>}
    </div>
  );
}

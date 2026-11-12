'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ExternalLink, KeyRound, Save, ShieldCheck, Terminal, Wallet, UserX } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { Amount, CopyButton, Countdown, Notice, Pill, Skeleton, Spinner } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { useApprovals } from '@/components/app/approvals';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { useEvent, useEvents } from '@/lib/events';
import { formatToken, formatUnits, hs, parseUnits, short, toUnix, clock } from '@/lib/format';
import type { Me } from '@/lib/types';

export default function DashboardPage() {
  return <RequireOwner><AppShell title="Dashboard"><Dashboard /></AppShell></RequireOwner>;
}

function Dashboard() {
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, refetchInterval: 15_000 });
  useEvent(['agent.linked', 'agent.revoked', 'approval.resolved', 'payment.paid', 'refund.sent', 'job.done'], () => qc.invalidateQueries({ queryKey: ['me'] }));

  if (me.isLoading || !cfg) return <div className="col"><Skeleton h={120} /><Skeleton h={80} /><Skeleton h={200} /></div>;
  if (me.error || !me.data) return <Notice tone="bad">Could not load your budget. {(me.error as Error)?.message}</Notice>;
  const m = me.data;
  const d = cfg.assetDecimals;

  return (
    <div className="col gap-l">
      <div className="grid2">
        <div className="card col">
          <div className="eyebrow"><Wallet size={12} /> Human budget · Hedera HTS</div>
          <Amount value={m.balance.amount} decimals={d} symbol="FUSD" size="xl" />
          <div className="kv"><span className="k">HBAR (fees)</span><span className="v">{Number(m.balance.hbar).toFixed(2)}</span></div>
          <div className="kv"><span className="k">Budget account</span><span className="v"><a className="link" href={hs.account(cfg.hashscan, m.budgetAccountId)} target="_blank" rel="noreferrer">{m.budgetAccountId} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Token</span><span className="v"><a className="link" href={hs.token(cfg.hashscan, cfg.asset)} target="_blank" rel="noreferrer">{cfg.asset} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Human (hashed)</span><span className="v mono">{short(m.humanHash, 8)}</span></div>
        </div>
        <div className="stats3">
          <Stat label="Cap / payment" v={formatToken(m.policy.capPerPayment, d)} />
          <Stat label="Daily cap" v={formatToken(m.policy.dailyCap, d)} />
          <Stat label="Spent today" v={formatToken(m.policy.spentToday, d)} />
        </div>
      </div>

      <div className="grid2">
        <PolicyCard me={m} />
        <LinkCard me={m} />
      </div>

      <AgentsCard me={m} />
      <LiveStrip humanHash={m.humanHash} />
    </div>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return <div className="card stat"><span className="eyebrow">{label}</span><span className="amount lg">{v}</span><span className="small muted">FUSD</span></div>;
}

function PolicyCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const { cfg } = useConfig();
  const d = cfg!.assetDecimals;
  const [cap, setCap] = useState(formatUnits(me.policy.capPerPayment, d));
  const [daily, setDaily] = useState(formatUnits(me.policy.dailyCap, d));
  const [allow, setAllow] = useState<string[]>(me.policy.allowlist);
  useEffect(() => { setCap(formatUnits(me.policy.capPerPayment, d)); setDaily(formatUnits(me.policy.dailyCap, d)); setAllow(me.policy.allowlist); }, [me.policy, d]);

  const save = useMutation({
    mutationFn: () => {
      const c = parseUnits(cap, d), dc = parseUnits(daily, d);
      if (!c || !dc) throw new Error('Enter amounts like 1.00');
      return api.putPolicy({ capPerPayment: c, dailyCap: dc, allowlist: allow });
    },
    onSuccess: (p) => { qc.setQueryData<Me>(['me'], (old) => (old ? { ...old, policy: p } : old)); },
    onError: report,
  });

  return (
    <div className="card col">
      <div className="eyebrow"><ShieldCheck size={12} /> Spend policy</div>
      <label className="field"><span className="label">Cap per payment (FUSD) — above this, World App approval</span>
        <span className="input-wrap"><input className="input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} /></span></label>
      <label className="field"><span className="label">Daily cap (FUSD)</span>
        <span className="input-wrap"><input className="input" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} /></span></label>
      <div className="eyebrow">Allowed providers</div>
      {cfg!.providers.map((p) => (
        <label key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
          <span className="row"><input type="checkbox" checked={allow.includes(p.id)} onChange={(e) => setAllow((a) => (e.target.checked ? [...a, p.id] : a.filter((x) => x !== p.id)))} /> {p.name} <span className="muted small mono">{p.id}</span></span>
          <span className="mono">{formatToken(p.price, d)} FUSD</span>
        </label>
      ))}
      <button className="btn" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : <Save size={16} />} Save policy</button>
    </div>
  );
}

function LinkCard({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('Agent D');
  const pair = useMutation({ mutationFn: () => api.pairing(label), onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }), onError: report });
  const unstable = me.world?.subStable === false;
  const cmd = `pnpm --filter @forkos/agents link "${label}"${unstable && me.pairing ? ` ${me.pairing.code}` : ''}`;
  return (
    <div className="card col">
      <div className="eyebrow"><Terminal size={12} /> Link an agent</div>
      <p className="small muted">Run this where the agent lives. It prints a World App QR; approve it with the same World ID you signed in with. The agent appears below the moment its HCS <b>LINK</b> lands.</p>
      <label className="field"><span className="label">Agent label</span><span className="input-wrap"><input className="input" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} /></span></label>
      <div className="row"><code className="mono small grow" style={{ wordBreak: 'break-all' }}>{cmd}</code><CopyButton text={cmd} /></div>
      {unstable && (
        <>
          <Notice tone="warn">This World environment doesn’t give a stable id per human, so linking needs a one-time pairing code.</Notice>
          {me.pairing ? (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="amount lg mono">{me.pairing.code}</span>
              <Countdown until={toUnix(me.pairing.expiresAt)} label="Valid" onExpire={() => qc.invalidateQueries({ queryKey: ['me'] })} />
            </div>
          ) : (
            <button className="btn ghost" onClick={() => pair.mutate()} disabled={pair.isPending}><KeyRound size={16} /> Get pairing code</button>
          )}
        </>
      )}
    </div>
  );
}

function AgentsCard({ me }: { me: Me }) {
  const { cfg } = useConfig();
  const approvals = useApprovals();
  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="eyebrow"><Bot size={12} /> Linked agents ({me.agents.length})</div>
        <Pill tone="info">Linked via World · logged on HCS</Pill>
      </div>
      {me.agents.length === 0 && <p className="muted">No agents yet — run the link command.</p>}
      <table className="tbl">
        <thead><tr><th>Agent</th><th>Address</th><th>Hedera account</th><th>Epoch</th><th>Status</th><th>Linked</th><th /></tr></thead>
        <tbody>
          {me.agents.map((a) => (
            <tr key={a.agentAddr} className={a.status === 'REVOKED' ? 'void' : ''}>
              <td><b>{a.label}</b></td>
              <td className="mono">{short(a.agentAddr)} <CopyButton text={a.agentAddr} small /></td>
              <td><a className="link mono" href={hs.account(cfg!.hashscan, a.accountId)} target="_blank" rel="noreferrer">{a.accountId}</a></td>
              <td className="mono">{a.epoch}</td>
              <td><Pill tone={a.status === 'ACTIVE' ? 'ok' : 'bad'}>{a.status}</Pill></td>
              <td className="small">{clock(toUnix(a.linkedAt))}</td>
              <td>{a.status === 'ACTIVE' && <button className="btn ghost" style={{ minHeight: 34 }} onClick={() => approvals.revoke(a.agentAddr, a.label)}><UserX size={14} /> Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LiveStrip({ humanHash }: { humanHash: string }) {
  const { recent } = useEvents();
  const mine = recent.filter((e) => !e.data.humanHash || e.data.humanHash === humanHash).slice(0, 5);
  if (!mine.length) return null;
  return (
    <div className="card">
      <div className="eyebrow">Live</div>
      <div className="timeline">{mine.map((e, i) => <div key={e.at + ':' + i} className="ev"><span className={`chip-t`}>{e.type}</span><span className="small mono">{new Date(e.at).toLocaleTimeString()}</span></div>)}</div>
    </div>
  );
}

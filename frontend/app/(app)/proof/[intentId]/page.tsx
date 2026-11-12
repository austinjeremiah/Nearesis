'use client';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileCheck2 } from 'lucide-react';
import { AppShell, RequireOwner } from '@/components/app/shell';
import { Notice, Pill, Skeleton, TechDetails } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toMirrorTxId, toUnix } from '@/lib/format';

export default function ProofPage() {
  return <RequireOwner><AppShell title="Proof"><Proof /></AppShell></RequireOwner>;
}

function Proof() {
  const { intentId } = useParams<{ intentId: string }>();
  const { cfg } = useConfig();
  const i = useQuery({ queryKey: ['intent', intentId], queryFn: () => api.intent(intentId), refetchInterval: (q) => (q.state.data && ['DONE', 'REFUNDED', 'VOID', 'FAILED'].includes(q.state.data.status) ? false : 3000) });
  const jobKey = i.data?.jobKey;
  const tl = useQuery({ queryKey: ['proof', 'tl', jobKey], queryFn: () => api.timeline(jobKey!), enabled: !!jobKey });

  if (i.isLoading || !cfg) return <Skeleton h={240} />;
  if (!i.data) return <Notice tone="bad">Unknown intent.</Notice>;
  const x = i.data;
  const d = cfg.assetDecimals;
  const trail = (tl.data?.events ?? []).filter((e) => (e as any).round === x.round || e.t === 'LINK').sort((a, b) => a.seq - b.seq);
  const claim = trail.find((e) => e.t === 'CLAIM' && String((e as any).agent).toLowerCase() === x.agentAddr.toLowerCase());
  const r = (x.result ?? {}) as { summary?: string; outputHash?: string; refundTxId?: string; agentkit?: { address: string; humanId: string | null } | null };
  const humanBacked = r.agentkit
    ? r.agentkit.humanId
      ? `✓ human-backed · AgentBook ${short(r.agentkit.humanId, 6)}`
      : `signed by ${short(r.agentkit.address)} · not in AgentBook`
    : 'no proof sent';

  return (
    <div className="col gap-l">
      <div className="row wrap" style={{ justifyContent: 'space-between' }}>
        <div><div className="eyebrow"><FileCheck2 size={12} /> Payment proof</div><h1 className="display">{formatToken(x.amount, d)} <span className="hl">FUSD</span></h1></div>
        <Pill tone={x.status === 'DONE' || x.status === 'PAID' ? 'ok' : x.status === 'REFUNDED' ? 'warn' : x.status === 'VOID' ? 'bad' : 'info'}>{x.status}</Pill>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="eyebrow">Intent (stored before sending)</div>
          {[
            ['Job', short(x.jobKey, 10)], ['Round', String(x.round)], ['Agent', short(x.agentAddr)], ['World AgentKit', humanBacked], ['Provider', x.providerId],
            ['Pays to', x.payTo], ['Tx id (ours)', x.txId], ['Dies at', clock(x.deadline)], ['Attempts', String(x.attempts ?? 1)], ['Last error', x.lastError ?? '—'],
          ].map(([k, v]) => <div className="kv" key={k}><span className="k">{k}</span><span className="v mono">{v}</span></div>)}
        </div>
        <div className="card">
          <div className="eyebrow">Hedera</div>
          <div className="kv"><span className="k">Consensus</span><span className="v mono">{x.consensusTimestamp ? `${x.consensusTimestamp} (${clock(toUnix(x.consensusTimestamp))})` : 'not on ledger'}</span></div>
          {x.consensusTimestamp && <div className="kv"><span className="k">HashScan</span><span className="v"><a className="link" href={hs.tx(cfg.hashscan, x.consensusTimestamp)} target="_blank" rel="noreferrer">open <ExternalLink size={12} /></a></span></div>}
          <div className="kv"><span className="k">Mirror REST</span><span className="v"><a className="link" href={`${cfg.mirrorUrl}/api/v1/transactions/${toMirrorTxId(x.txId)}`} target="_blank" rel="noreferrer">raw JSON <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">HCS topic</span><span className="v"><a className="link" href={hs.topic(cfg.hashscan, cfg.topicId)} target="_blank" rel="noreferrer">{cfg.topicId} <ExternalLink size={12} /></a></span></div>
          <div className="kv"><span className="k">Winning claim</span><span className="v mono">{claim ? `HCS #${claim.seq} · ${(claim as any).svc} · paid by ${claim.payer ?? '—'}` : '—'}</span></div>
        </div>
      </div>

      <div className="card">
        <div className="eyebrow">HCS trail (round {x.round})</div>
        <div className="timeline">{trail.map((e) => <div className="ev" key={e.seq}><span className={`chip-t ${e.t}`}>{e.t}</span><span className="mono small">#{e.seq} · {clock(toUnix(e.cts))}</span></div>)}</div>
      </div>

      {(r.summary || r.refundTxId) && (
        <div className="card col">
          <div className="eyebrow">{r.refundTxId ? 'Refunded' : 'Delivered'}</div>
          {r.summary && <p>{r.summary}</p>}
          <TechDetails rows={[{ label: 'Output hash', value: r.outputHash }, { label: 'Refund tx', value: r.refundTxId }]} />
        </div>
      )}
    </div>
  );
}

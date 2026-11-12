'use client';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { clock, formatToken, hs, short, toUnix } from '@/lib/format';
import type { Counter } from '@/lib/types';

export function Lanes({ jobKey, since }: { jobKey: string; since: number }) {
  const q = useQuery({ queryKey: ['race', 'counter', jobKey, since], queryFn: () => api.counter(jobKey, since), refetchInterval: 4000, refetchIntervalInBackground: true });
  const c = q.data;
  return (
    <div className="grid2">
      <Lane tone="bad" title="Baseline · stock x402" cap="3 agents · 3 wallets · no coordination" side={c?.baseline} />
      <Lane tone="ok" title="ForkOS" cap="3 forks · 1 human budget · exactly once" side={c?.forkos} />
    </div>
  );
}

function Lane({ tone, title, cap, side }: { tone: 'ok' | 'bad'; title: string; cap: string; side?: Counter['forkos'] }) {
  const { cfg } = useConfig();
  const n = side?.payments ?? 0;
  return (
    <div className={`lane ${tone}`}>
      <div className="lane-h"><b className="eyebrow" style={{ color: 'var(--ink)' }}>{title}</b><span className="small">Hedera Mirror Node</span></div>
      <div key={n} className="big-n flash">{side ? n : '–'}</div>
      <div className="cap">{n === 1 ? 'payment' : 'payments'} · {cap}</div>
      <div className="rows">
        {(side?.txs ?? []).map((t) => (
          <div className="r" key={t.txId}>
            <span className="mono">{short(t.txId, 12)}</span>
            <span>{clock(toUnix(t.cts))}</span>
            <span className="mono">→ {t.to}</span>
            <span className="mono">{formatToken(t.amount, cfg?.assetDecimals ?? 6)}</span>
            {cfg && <a href={hs.tx(cfg.hashscan, t.cts)} target="_blank" rel="noreferrer" className="link"><ExternalLink size={13} /></a>}
          </div>
        ))}
        {side && side.txs.length === 0 && <div className="r muted">no payments yet</div>}
      </div>
    </div>
  );
}

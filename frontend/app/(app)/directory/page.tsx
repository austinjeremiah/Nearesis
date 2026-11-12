'use client';
import { useQuery } from '@tanstack/react-query';
import { Boxes, ExternalLink } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { Notice, Pill, Skeleton } from '@/components/app/ui';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/config';
import { formatToken, hs } from '@/lib/format';
import { useOwner } from '@/lib/session';

export default function DirectoryPage() {
  const { cfg } = useConfig();
  const owner = useOwner();
  const dir = useQuery({ queryKey: ['directory'], queryFn: api.directory, refetchInterval: 15_000 });
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: !!owner });
  const allow = new Set(me.data?.policy.allowlist ?? []);
  return (
    <AppShell title="Directory">
      <div className="col gap-l">
        <div>
          <div className="eyebrow"><Boxes size={12} /> Hedera HCS · SERVICE announcements</div>
          <h1 className="display">Who sells <span className="hl">{cfg?.capability ?? 'transcribe+summarize.v1'}</span></h1>
        </div>
        <Notice tone="info">Read from the public HCS topic. Each provider announces itself from its own Hedera account, and only announcements whose payer and payout match a registered provider account are listed — nobody can list a fake provider.</Notice>
        {dir.isLoading && <Skeleton h={140} />}
        {dir.error && <Notice tone="bad">Directory read failed: {(dir.error as Error).message}</Notice>}
        <div className="grid3">
          {dir.data?.services.map((s) => (
            <div key={s.providerId} className="card col">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b className="h3">{s.name}</b>
                {owner && <Pill tone={allow.has(s.providerId) ? 'ok' : 'bad'}>{allow.has(s.providerId) ? 'Allowed' : 'Blocked by policy'}</Pill>}
              </div>
              <span className="amount lg">{formatToken(s.price, cfg?.assetDecimals ?? 6)} <span className="small">FUSD / job</span></span>
              <div className="kv"><span className="k">Provider</span><span className="v mono">{s.providerId}</span></div>
              <div className="kv"><span className="k">Network</span><span className="v mono">{s.network}</span></div>
              <div className="kv"><span className="k">Endpoint</span><span className="v mono small">{s.endpoint}</span></div>
              <div className="kv"><span className="k">Pays to</span><span className="v">{cfg ? <a className="link mono" href={hs.account(cfg.hashscan, s.payTo)} target="_blank" rel="noreferrer">{s.payTo} <ExternalLink size={12} /></a> : s.payTo}</span></div>
              <div className="kv"><span className="k">Announced</span><span className="v">{cfg ? <a className="link mono" href={hs.topic(cfg.hashscan, cfg.topicId)} target="_blank" rel="noreferrer">HCS #{s.seq} <ExternalLink size={12} /></a> : `HCS #${s.seq}`}</span></div>
            </div>
          ))}
        </div>
        {dir.data && dir.data.services.length === 0 && <Notice tone="warn">No services announced on HCS yet — are the providers running?</Notice>}
      </div>
    </AppShell>
  );
}

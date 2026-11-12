'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fingerprint, Globe, RotateCcw, ShieldAlert, Smartphone } from 'lucide-react';
import { AppShell } from '@/components/app/shell';
import { CopyButton, Countdown, QrView, StateBlock, StepList, Spinner, Notice } from '@/components/app/ui';
import { report } from '@/components/app/providers';
import { api } from '@/lib/api';
import { session, useOwner } from '@/lib/session';

type Start = Awaited<ReturnType<typeof api.loginStart>>;
type Phase = { k: 'idle' } | { k: 'waiting'; s: Start; until: number } | { k: 'done'; status: 'DENIED' | 'EXPIRED' | 'FAILED'; reason?: string | null };

export default function LoginPage() {
  const router = useRouter();
  const next = useSearchParams().get('next') || '/dashboard';
  const owner = useOwner();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  useEffect(() => { if (owner) router.replace(next); }, [owner, next, router]);

  const start = async () => {
    setBusy(true);
    try {
      const s = await api.loginStart();
      setPhase({ k: 'waiting', s, until: Math.floor(Date.now() / 1000) + s.expiresIn });
    } catch (e) { report(e); } finally { setBusy(false); }
  };

  useEffect(() => {
    if (phase.k !== 'waiting') return;
    let alive = true;
    const every = Math.max(phase.s.interval, 2) * 1000;
    const tick = async () => {
      if (inflight.current) return;
      inflight.current = true;
      try {
        const r = await api.loginPoll(phase.s.attemptId);
        if (r.status === 'APPROVED' && r.token && r.human) {
          // store even if unmounted — the token is handed out exactly once
          session.set({ token: r.token, humanHash: r.human.humanHash, budgetAccountId: r.human.budgetAccountId });
          return; // the useOwner effect redirects
        }
        if (alive && (r.status === 'DENIED' || r.status === 'EXPIRED' || r.status === 'FAILED')) setPhase({ k: 'done', status: r.status, reason: r.reason });
      } catch { /* transient — keep polling */ } finally { inflight.current = false; }
    };
    const t = setInterval(tick, every);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [phase]);

  return (
    <AppShell narrow title="Sign in">
      <div className="col gap-l">
        <div>
          <div className="eyebrow">World ID Agent Pass</div>
          <h1 className="display">Sign in as the <span className="hl">human</span> behind your agents</h1>
        </div>

        {phase.k === 'idle' && (
          <div className="card col">
            <p className="muted">Your agents spend from one budget tied to one verified human. Linking, firing and over-cap payments always come back to World App for approval.</p>
            <button className="btn big block" onClick={start} disabled={busy}>{busy ? <Spinner /> : <Globe size={20} />} Sign in with World ID</button>
          </div>
        )}

        {phase.k === 'waiting' && (
          <div className="card col center">
            <QrView payload={phase.s.verificationUriComplete} size={240} />
            <div className="eyebrow">or enter this code in World App</div>
            <div className="row" style={{ gap: 8 }}>
              <span className="amount xl mono">{phase.s.userCode}</span>
              <CopyButton text={phase.s.userCode} />
            </div>
            <a className="btn ghost block" href={phase.s.verificationUriComplete} target="_blank" rel="noreferrer"><Smartphone size={18} /> Open World App</a>
            <Countdown until={phase.until} label="Expires in" onExpire={() => setPhase({ k: 'done', status: 'EXPIRED' })} />
            <StepList steps={[
              { label: 'Code issued', state: 'done' },
              { label: 'Approve in World App', state: 'active', icon: Fingerprint },
              { label: 'Budget account ready', state: 'todo' },
            ]} />
          </div>
        )}

        {phase.k === 'done' && (
          <StateBlock
            icon={ShieldAlert}
            tone="bad"
            title={phase.status === 'DENIED' ? 'Denied in World App' : phase.status === 'EXPIRED' ? 'Code expired' : 'Sign-in failed'}
            message={phase.reason ?? 'Nothing was linked. Start again.'}
            action={<button className="btn" onClick={() => setPhase({ k: 'idle' })}><RotateCcw size={16} /> Try again</button>}
          />
        )}

        <Notice tone="info">The web app never sees your World identity — only a hashed human id and a session token.</Notice>
      </div>
    </AppShell>
  );
}

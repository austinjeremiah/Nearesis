'use client';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BadgeCheck, Fingerprint, ShieldAlert, Smartphone, UserX, Wallet } from 'lucide-react';
import { api } from '@/lib/api';
import { useEvent } from '@/lib/events';
import { session } from '@/lib/session';
import { toUnix } from '@/lib/format';
import { CopyButton, Countdown, QrView, Sheet, StateBlock, StepList } from './ui';

type Open = {
  approvalId: string;
  kind: string; // REVOKE | OVERCAP (LINK is shown by the CLI)
  title: string;
  action: unknown;
  userCode: string;
  uri: string;
  until: number;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'USED';
};
type Ctx = { revoke: (agentAddr: string, label?: string) => Promise<void> };
const C = createContext<Ctx | null>(null);
export const useApprovals = () => {
  const c = useContext(C);
  if (!c) throw new Error('useApprovals outside ApprovalProvider');
  return c;
};

export function ApprovalProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [cur, setCur] = useState<Open | null>(null);

  const revoke = useCallback(async (agentAddr: string, label?: string) => {
    try {
      const r = await api.revokeStart(agentAddr);
      setCur({ approvalId: r.approvalId, kind: 'REVOKE', title: `Fire ${label ?? agentAddr.slice(0, 10)}`, action: { agentAddr }, userCode: r.userCode, uri: r.verificationUriComplete, until: Math.floor(Date.now() / 1000) + r.expiresIn, status: 'PENDING' });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);

  useEvent(['approval.pending'], (e) => {
    const me = session.get();
    if (!me || e.data.humanHash !== me.humanHash) return;
    setCur((c) => (c?.approvalId === e.data.approvalId ? c : {
      approvalId: e.data.approvalId,
      kind: e.data.kind,
      title: e.data.kind === 'OVERCAP' ? 'Approve an over-cap payment' : e.data.kind === 'REVOKE' ? 'Fire an agent' : 'World approval',
      action: e.data.action,
      userCode: e.data.userCode,
      uri: e.data.verificationUriComplete,
      until: toUnix(e.data.expiresAt) || Math.floor(Date.now() / 1000) + 300,
      status: 'PENDING',
    }));
  });
  useEvent(['approval.resolved'], (e) => setCur((c) => (c && c.approvalId === e.data.approvalId ? { ...c, status: e.data.status } : c)));

  // poll while pending
  useEffect(() => {
    if (!cur || cur.status !== 'PENDING') return;
    const t = setInterval(async () => {
      try {
        const a = await api.approval(cur.approvalId);
        if (a.status !== 'PENDING') setCur((c) => (c && c.approvalId === a.approvalId ? { ...c, status: a.status } : c));
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(t);
  }, [cur?.approvalId, cur?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // finish
  useEffect(() => {
    if (!cur) return;
    if (cur.status === 'APPROVED' || cur.status === 'USED') {
      toast.success(cur.kind === 'REVOKE' ? 'Agent fired — its epoch is now stale' : 'Approved in World App');
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['job'] });
      const t = setTimeout(() => setCur(null), 900);
      return () => clearTimeout(t);
    }
  }, [cur?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    if (cur?.status === 'PENDING') { try { await api.approvalCancel(cur.approvalId); } catch { /* ignore */ } }
    setCur(null);
  };

  const Icon = cur?.kind === 'REVOKE' ? UserX : cur?.kind === 'OVERCAP' ? Wallet : Fingerprint;
  const rows = cur && cur.action && typeof cur.action === 'object' ? Object.entries(cur.action as Record<string, unknown>) : [];

  return (
    <C.Provider value={{ revoke }}>
      {children}
      {/* Closing the sheet only hides it: the request stays open and can still be approved on the phone.
          Denying is an explicit action (the button below) — otherwise dismissing the sheet silently denied the
          payment and the agents started a new round. */}
      <Sheet open={!!cur} onClose={() => setCur(null)} title={cur?.title} icon={Icon}>
        {cur && (cur.status === 'DENIED' || cur.status === 'EXPIRED') ? (
          <StateBlock icon={ShieldAlert} tone="bad" title={cur.status === 'DENIED' ? 'Denied in World App' : 'Approval expired'}
            message={cur.kind === 'OVERCAP' ? 'No payment was made. The agent gets APPROVAL_DENIED.' : 'Nothing changed.'}
            action={<button className="btn" onClick={() => setCur(null)}>Close</button>} />
        ) : cur && (
          <>
            {rows.length > 0 && (
              <div className="card">{rows.map(([k, v]) => <div className="kv" key={k}><span className="k">{k}</span><span className="v mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span></div>)}</div>
            )}
            <div className="col center">
              <QrView payload={cur.uri} size={220} />
              <div className="row"><span className="amount lg mono">{cur.userCode}</span><CopyButton text={cur.userCode} /></div>
              <a className="btn ghost block" href={cur.uri} target="_blank" rel="noreferrer"><Smartphone size={16} /> Open World App</a>
              <Countdown until={cur.until} label="Expires in" />
            </div>
            <StepList steps={[
              { label: 'Request created', state: 'done' },
              { label: 'Human approves in World App', state: cur.status === 'PENDING' ? 'active' : 'done', icon: Fingerprint },
              { label: cur.kind === 'REVOKE' ? 'REVOKE on HCS · providers refuse the agent' : 'Payment continues', state: cur.status === 'PENDING' ? 'todo' : 'done', icon: BadgeCheck },
            ]} />
            <button className="btn ghost block" onClick={cancel}>{cur.kind === 'OVERCAP' ? 'Deny this payment' : 'Deny this request'}</button>
          </>
        )}
      </Sheet>
    </C.Provider>
  );
}

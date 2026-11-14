import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Wordmark from '@/components/Wordmark';
import { Badge } from '@/components/nx/evidence';
import { KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import { API_URL, SESSION_COOKIE } from '@/lib/api/config';
import type { InvitePreview } from '@/lib/api/shell';
import { formatUtc } from '@/lib/format';
import AcceptButton from './accept-button';

export const metadata: Metadata = { title: 'Accept invitation · Nearesis' };

const ROLE_COPY: Record<string, { grants: string; cannot: string }> = {
  viewer: { grants: 'read workspaces, evidence and publications', cannot: 'ask questions, edit the canvas, approve spending or publish' },
  analyst: { grants: 'ask questions, edit the canvas, add markers, fork', cannot: 'manage members, change budgets or publish the official thesis' },
  admin: { grants: 'everything an analyst can, plus members, invitations, budgets and publishing', cannot: 'remove or demote an owner' },
  owner: { grants: 'everything, including roles', cannot: '' },
};

async function preview(token: string): Promise<{ ok: true; data: InvitePreview } | { ok: false; status: number; code: string | null }> {
  try {
    const r = await fetch(`${API_URL}/v1/invites/preview?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (r.ok) return { ok: true, data: (await r.json()) as InvitePreview };
    const b = (await r.json().catch(() => ({}))) as { reasonCode?: string; errorCode?: string };
    return { ok: false, status: r.status, code: b.reasonCode ?? b.errorCode ?? null };
  } catch {
    return { ok: false, status: 503, code: 'UPSTREAM_DEGRADED' };
  }
}

/**
 * Invitation. The token is verified by the API (signature, expiry, single use);
 * this page only shows what the API returns. Accepting needs a session, so a
 * signed-out visitor is sent to sign in and returned here.
 */
export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const signedIn = !!(await cookies()).get(SESSION_COOKIE)?.value;
  const p = token ? await preview(token) : null;
  const state = p?.ok ? p.data.state : null;
  const usable = p?.ok && state === 'pending';
  const here = token ? `/accept-invite?token=${encodeURIComponent(token)}` : '/accept-invite';

  let heading = 'You have been invited';
  let sub = 'Review what this invitation grants before you accept it.';
  if (!token) {
    heading = 'No invitation link';
    sub = 'Open the link you were sent. It carries a signed token.';
  } else if (p && !p.ok) {
    heading = p.status === 404 ? 'We could not find this invitation' : 'This invitation cannot be used';
    sub = 'The link may be incomplete, expired or already used.';
  } else if (state === 'expired') {
    heading = 'This invitation expired';
    sub = 'Invitations are short-lived so a forwarded link cannot be used later by someone else.';
  } else if (state && state !== 'pending') {
    heading = state === 'accepted' ? 'This invitation was already used' : 'This invitation was revoked';
    sub = 'An invitation works once.';
  }

  return (
    <>
      <div className="auth-panel">
        <><span className="wm-on-light"><Wordmark tone="black" size={30} /></span><span className="wm-on-dark"><Wordmark tone="white" size={30} /></span></>
        <div className="col gap2">
          <h1 className="h1" data-testid="invite-heading">{heading}</h1>
          <p className="muted">{sub}</p>
        </div>

        {p?.ok && (
          <div className="card" data-testid="invite-preview" data-state={p.data.state}>
            <div className="card-body">
              <KeyValues
                rows={[
                  { k: 'Organization', v: p.data.orgName },
                  { k: 'Invited email', v: <span className="mono">{p.data.email}</span> },
                  {
                    k: 'Role',
                    v: (
                      <span className="row gap2">
                        <Badge tone="info">{p.data.role}</Badge>
                        <span className="small dim">{ROLE_COPY[p.data.role]?.grants}</span>
                      </span>
                    ),
                  },
                  ...(ROLE_COPY[p.data.role]?.cannot ? [{ k: 'Cannot do', v: ROLE_COPY[p.data.role]!.cannot }] : []),
                  { k: 'State', v: p.data.state },
                  { k: 'Expires', v: <span className="mono">{formatUtc(p.data.expiresAt)}</span> },
                ]}
              />
            </div>
          </div>
        )}

        {usable && token ? (
          signedIn ? (
            <AcceptButton token={token} />
          ) : (
            <div className="col gap2">
              <Notice tone="info" title="Sign in to accept">Accepting adds your account to this organization.</Notice>
              <div className="row gap2">
                <LinkButton href={`/login?next=${encodeURIComponent(here)}`} variant="primary" size="lg">
                  Sign in to accept
                </LinkButton>
              </div>
            </div>
          )
        ) : (
          <Notice tone="warn" title="Ask for a new link">Ask the person who invited you to send a new invitation.</Notice>
        )}
      </div>

      <aside className="auth-aside">
        <span className="label" style={{ color: 'var(--text-on-dark-2)' }}>
          What a role means here
        </span>
        <p className="claim">
          Agents propose.<br />
          <span className="hl">You authorize.</span>
        </p>
        <p className="small" style={{ color: 'var(--text-on-dark-2)', maxWidth: '46ch' }}>
          Every tool call crosses a policy gateway. Spending, publishing under your name and any chain write need an approval bound to the exact action, and that approval is void the moment a parameter changes.
        </p>
      </aside>
    </>
  );
}

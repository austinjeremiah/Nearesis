import type { Metadata } from 'next';
import Wordmark from '@/components/Wordmark';
import { Badge } from '@/components/nx/evidence';
import { KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';

export const metadata: Metadata = { title: 'Accept invitation · Nearesis' };

/**
 * Spec 5.1 — invitation.
 *
 * The invite is verified server-side before this renders; the page only shows
 * what the signed payload contained. An expired invite offers "Request a new
 * invite" only when that workflow exists, so until the backend supports it the
 * action is absent rather than present and dead.
 */
export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; state?: string }>;
}) {
  const { state } = await searchParams;
  const expired = state === 'expired';

  return (
    <>
      <div className="auth-panel">
        <Wordmark tone="black" size={30} />
        <div className="col gap2">
          <h1 className="h1">{expired ? 'This invitation expired' : 'You have been invited'}</h1>
          <p className="muted">
            {expired
              ? 'Invitations are short-lived so a forwarded link cannot be used later by someone else.'
              : 'Review what this invitation grants before you accept it.'}
          </p>
        </div>

        <div className="card">
          <div className="card-body">
            <KeyValues
              rows={[
                { k: 'Organization', v: 'Nearesis Research' },
                { k: 'Workspace', v: 'Intents adoption signal' },
                {
                  k: 'Role',
                  v: (
                    <span className="row gap2">
                      <Badge tone="info">Analyst</Badge>
                      <span className="small dim">query, edit canvas, add markers, fork</span>
                    </span>
                  ),
                },
                {
                  k: 'Cannot do',
                  v: 'Change certified metrics, publish the official thesis, or raise a spending cap.',
                },
                { k: 'Invited by', v: 'r.mehta' },
                {
                  k: 'Expires',
                  v: <span className="mono">{formatUtc('2026-11-11T09:00:00.000Z')}</span>,
                },
              ]}
            />
          </div>
        </div>

        {expired ? (
          <Notice tone="warn" title="Ask for a new link">
            Invitation renewal is handled by the backend, which is not connected yet. Contact the
            person who invited you.
          </Notice>
        ) : (
          <div className="row gap2">
            <LinkButton href="/home" variant="primary" size="lg">
              Accept invitation
            </LinkButton>
            <LinkButton href="/login" size="lg">
              Decline
            </LinkButton>
          </div>
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
          Every tool call crosses a policy gateway. Spending, publishing under your name and any
          chain write need an approval bound to the exact action, and that approval is void the
          moment a parameter changes.
        </p>
      </aside>
    </>
  );
}

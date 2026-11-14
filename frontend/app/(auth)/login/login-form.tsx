'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { safeNextPath } from '@/lib/auth/next-path';
import { Button, Field, Input, Notice } from '@/components/nx/ui';
import { NearErrorNotice } from '@/components/nx/near-error';
import { errorFromResponse, networkError } from '@/lib/api/errors';
import { challengeAndSign } from '@/lib/near/challenge';
import { getConnector } from '@/lib/near/wallet';

type Providers = { devLogin: boolean; oidc: boolean };

const OIDC_ERRORS: Record<string, string> = {
  oidc_not_configured: 'Single sign-on is not configured on this server yet.',
  oidc_state: 'The sign-in could not be matched to this browser. Start again from this page.',
  oidc_refused: 'The identity provider refused the sign-in.',
  oidc_not_provisioned: 'Your identity has no account here. Ask an organization owner to add you.',
  oidc_unreachable: 'The API is not reachable.',
  oidc_rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  oidc_failed: 'Sign-in failed.',
};

/**
 * Sign-in methods come from /api/auth/providers, so the page only offers what
 * the server has configured: the dev login (NEARESIS_DEV_LOGIN=1, never in
 * production) and, once the backend serves /v1/auth/*, OIDC (NEARESIS_OIDC=1).
 */
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get('next');
  const next = safeNextPath(rawNext, '/home');
  const [providers, setProviders] = useState<Providers | null>(null);
  const [subject, setSubject] = useState('dev-owner');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlError = params.get('error');
  const [nearPending, setNearPending] = useState(false);
  const [nearError, setNearError] = useState<unknown>(null);

  // Load the wallet connector in the browser only, so the popup opens without delay on click.
  useEffect(() => {
    void getConnector().catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch('/api/auth/providers', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => setProviders({ devLogin: false, oidc: false }));
  }, []);

  async function nearLogin() {
    setNearPending(true);
    setNearError(null);
    setError(null);
    try {
      const { challenge, sig } = await challengeAndSign();
      let r: Response;
      try {
        r = await fetch('/api/auth/near/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ challengeId: challenge.challengeId, ...sig }),
          credentials: 'same-origin',
        });
      } catch (e) {
        throw networkError(e);
      }
      if (!r.ok) throw errorFromResponse(r.status, await r.json().catch(() => null), r.headers);
      router.replace(next);
      router.refresh();
    } catch (e) {
      setNearError(e);
    } finally {
      setNearPending(false);
    }
  }

  async function devLogin() {
    setPending(true);
    setError(null);
    try {
      const r = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject }),
        credentials: 'same-origin',
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setError(b.message ?? `Sign-in failed (${r.status}).`);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError('The server could not be reached.');
    } finally {
      setPending(false);
    }
  }

  if (!providers) return <p className="small dim">Checking sign-in options</p>;

  return (
    <div className="col gap3">
      <div className="col gap2" data-testid="near-login">
        <Button variant="primary" size="lg" pending={nearPending} onClick={() => void nearLogin()} data-testid="near-login-button">
          Sign in with NEAR wallet
        </Button>
        <p className="small dim">Testnet. You sign a message that proves you own the account; nothing is sent on chain and no funds move.</p>
        <NearErrorNotice error={nearError} title="Wallet sign-in failed" />
      </div>
      {providers.oidc && (
        <a className="btn lg" href={`/api/auth/oidc/start?next=${encodeURIComponent(next)}`}>
          Continue with single sign-on
        </a>
      )}
      {/* The development sign-in is for automated tests only: it needs the server flag AND ?dev=1 in the address. */}
      {providers.devLogin && params.get('dev') === '1' && (
        <div className="col gap2" data-testid="dev-login">
          <Notice tone="warn" title="Development sign-in">
            Enabled by NEARESIS_DEV_LOGIN on this server. It signs in as the subject below against the local API and is never available in production.
          </Notice>
          <Field label="Subject">
            <Input id="dev-subject" value={subject} onChange={(e) => setSubject(e.target.value)} autoComplete="off" />
          </Field>
          <Button variant="primary" size="lg" pending={pending} onClick={devLogin} data-testid="dev-login-button">
            Sign in (dev)
          </Button>
        </div>
      )}
      {urlError && !error && (
        <Notice tone={urlError === 'oidc_not_configured' ? 'info' : 'bad'} title="Single sign-on">
          <span data-testid="login-error" data-code={urlError}>{OIDC_ERRORS[urlError] ?? 'Sign-in did not complete. Try again.'}</span>
        </Notice>
      )}
      {error && (
        <Notice tone="bad" title="Sign-in failed">
          {error}
        </Notice>
      )}
    </div>
  );
}

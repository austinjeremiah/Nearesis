'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Field, Input, Notice } from '@/components/nx/ui';

type Providers = { devLogin: boolean; oidc: boolean };

/**
 * Sign-in methods come from /api/auth/providers, so the page only offers what
 * the server has configured: the dev login (NEARESIS_DEV_LOGIN=1, never in
 * production) and, once the backend serves /v1/auth/*, OIDC (NEARESIS_OIDC=1).
 */
export default function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const rawNext = params.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/home';
  const [providers, setProviders] = useState<Providers | null>(null);
  const [subject, setSubject] = useState('dev-owner');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/providers', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setProviders)
      .catch(() => setProviders({ devLogin: false, oidc: false }));
  }, []);

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
      {providers.oidc && (
        <a className="btn primary lg" href={`/api/auth/oidc/start?next=${encodeURIComponent(next)}`}>
          Continue with single sign-on
        </a>
      )}
      {providers.devLogin && (
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
      {!providers.oidc && !providers.devLogin && (
        <Notice tone="info" title="No sign-in method is configured">
          This server has neither single sign-on nor the development sign-in enabled.
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

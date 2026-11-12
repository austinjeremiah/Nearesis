import type { Metadata } from 'next';
import Link from 'next/link';
import Wordmark from '@/components/Wordmark';
import { LinkButton } from '@/components/nx/ui';
import { Suspense } from 'react';
import LoginForm from './login-form';

export const metadata: Metadata = { title: 'Sign in · Nearesis' };

/**
 * Spec 5.1 — login.
 *
 * Only configured identity providers are shown. There is no decorative Google
 * button standing in for an integration that does not exist, and no password
 * field, because the production path is OIDC. LoginForm offers the dev login
 * only when the server enables it, and OIDC only when it is configured.
 */
export default function LoginPage() {
  return (
    <>
      <div className="auth-panel">
        <Wordmark tone="black" size={30} />

        <div className="col gap2">
          <h1 className="h1">Sign in</h1>
          <p className="muted">
            Nearesis is a research workspace. Sign in with your organization account to open your
            investigations.
          </p>
        </div>

        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>

        <div className="col gap2">
          <LinkButton href="/welcome" size="lg">
            What is Nearesis?
          </LinkButton>
        </div>

        <p className="small dim">
          By continuing you agree that research published from this account carries your name. See{' '}
          <Link className="link" href="/">
            the product overview
          </Link>
          .
        </p>
      </div>

      <aside className="auth-aside">
        <span className="label" style={{ color: 'var(--text-on-dark-2)' }}>
          Nearesis
        </span>
        <p className="claim">
          Research that<br />
          <span className="hl">shows its work.</span>
        </p>
        <p className="small" style={{ color: 'var(--text-on-dark-2)', maxWidth: '46ch' }}>
          Every chart carries its query, its semantic version and the snapshot it was built from.
          A reader who disagrees with the conclusion can rebuild it offline and check.
        </p>
      </aside>
    </>
  );
}

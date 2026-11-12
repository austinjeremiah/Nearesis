'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { GitFork, LogOut, Radio, WifiOff } from 'lucide-react';
import { useConfig } from '@/lib/config';
import { useEvents } from '@/lib/events';
import { session, useOwner } from '@/lib/session';
import { Notice, Pill, Spinner } from './ui';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/race', label: 'Race' },
  { href: '/directory', label: 'Directory' },
];

export function AppShell({ title, children, right, narrow }: { title?: string; children: ReactNode; right?: ReactNode; narrow?: boolean }) {
  const path = usePathname();
  const owner = useOwner();
  const { cfg, error } = useConfig();
  const { status } = useEvents();
  return (
    <div className={`sp-shell wide${narrow ? ' narrow' : ''}`}>
      {status === 'down' && <div className="sp-banner warn"><WifiOff size={16} /> Live updates are off — reconnecting…</div>}
      <header className="sp-top">
        <Link href="/" className="sp-brand" aria-label="Klero home">
          <span className="mark"><GitFork size={16} /></span>Klero
        </Link>
        <nav className="navlinks">
          {NAV.map((n) => <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''}>{n.label}</Link>)}
        </nav>
        <div className="title">{title ?? ''}</div>
        {right}
        <Pill tone={status === 'live' ? 'ok' : 'warn'} icon={Radio}>{status === 'live' ? 'Live' : 'Reconnecting'}</Pill>
        {cfg && <Pill tone="ink">{cfg.network}</Pill>}
        {owner && (
          <button className="sp-icon-btn" title="Sign out" aria-label="Sign out" onClick={() => { session.clear(); location.href = '/login'; }}>
            <LogOut size={16} />
          </button>
        )}
      </header>
      <main className="sp-page">
        {error && !cfg ? <Notice tone="bad"><b>Can’t reach the Klero API.</b> Check <code>NEXT_PUBLIC_API_URL</code> and the API’s <code>WEB_ORIGIN</code>.</Notice> : children}
      </main>
    </div>
  );
}

/** Wrap owner-only pages. Redirects to /login?next=… when there is no fos_ token. */
export function RequireOwner({ children }: { children: ReactNode }) {
  const owner = useOwner();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (typeof window !== 'undefined' && !session.get()) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [owner, path, router]);
  if (!owner) return <div className="center" style={{ padding: 40 }}><Spinner /></div>;
  return <>{children}</>;
}

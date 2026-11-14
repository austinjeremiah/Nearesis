import '../../app.css';
import '@/components/nx/thesis-track/thesis-track.css';
import '@/components/nx/thesis/thesis.css';
import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Wordmark from '@/components/Wordmark';
import { ThemeToggle } from '@/components/nx/theme';
import { EmptyState } from '@/components/nx/ui';
import { SESSION_COOKIE } from '@/lib/api/config';
import { DEFAULT_THEME, THEME_COOKIE, type Theme } from '@/lib/theme';
import { loadPublicThesis } from '@/lib/thesis/public';
import PublicThesisView from '@/components/nx/thesis/public-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Shared thesis · Nearesis', robots: { index: false } };

const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@300;400;500;600;700' +
  '&family=Stack+Sans+Notch:wght@300;400;500;600' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

export default async function PublicThesisPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  let slug = raw;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    /* keep the raw segment */
  }
  const jar = await cookies();
  const saved = jar.get(THEME_COOKIE)?.value;
  const theme: Theme = saved === 'light' || saved === 'dark' ? saved : DEFAULT_THEME;
  const signedIn = jar.has(SESSION_COOKIE);
  const importPath = `/thesis/import/${encodeURIComponent(slug)}`;
  const openHref = signedIn ? importPath : `/login?next=${encodeURIComponent(importPath)}`;
  const o = await loadPublicThesis(slug);
  const wrap = (children: React.ReactNode) => (
    <div className="nx th-pub" data-theme={theme}>
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />
      <header className="th-pub-bar">
        <a href="/" aria-label="Nearesis home" className="pub-brand">
          <span className="wm-on-light"><Wordmark tone="black" size={22} /></span>
          <span className="wm-on-dark"><Wordmark tone="white" size={22} /></span>
        </a>
        <span className="pub-tag">Shared thesis</span>
        <span className="pub-spacer" />
        <ThemeToggle />
      </header>
      <main className="th-pub-body">{children}</main>
    </div>
  );
  if (o.kind === 'not_found')
    return wrap(
      <div data-testid="public-thesis-not-found">
        <EmptyState title="Thesis not found" body="No thesis is published under this link. It may have been unpublished, or the link is wrong." />
      </div>,
    );
  if (o.kind === 'rate_limited')
    return wrap(
      <div data-testid="public-thesis-rate-limited">
        <EmptyState title="Too many requests" body={`Try again${o.retryAfter ? ` in ${o.retryAfter} seconds` : ' shortly'}.`} />
      </div>,
    );
  if (o.kind === 'unavailable')
    return wrap(
      <div data-testid="public-thesis-unavailable">
        <EmptyState title="Thesis unavailable" body={o.message} />
      </div>,
    );
  return wrap(<PublicThesisView doc={o.doc} slug={slug} receipts={o.receipts} strength={o.strength} challenges={o.challenges} openHref={openHref} signedIn={signedIn} />);
}

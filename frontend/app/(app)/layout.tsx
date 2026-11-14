import type { ReactNode } from 'react';
import '../app.css';
import Providers from '@/components/providers';
import { cookies } from 'next/headers';
import { ThemeSync } from '@/components/nx/theme';
import { DEFAULT_THEME, THEME_COOKIE, type Theme } from '@/lib/theme';

/**
 * App route group. Deliberately does not load the marketing site's Webflow
 * stylesheet or runtime: the two style systems share tokens and a visual
 * language, but never share a stylesheet.
 *
 * Three faces, per spec 3.1. Inter Tight for the interface, Stack Sans Notch for
 * display numerals, IBM Plex Mono for anything machine-produced: metric ids,
 * hashes, query fragments and timestamps.
 */
const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@300;400;500;600;700' +
  '&family=Stack+Sans+Notch:wght@300;400;500;600' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const saved = (await cookies()).get(THEME_COOKIE)?.value;
  const theme: Theme = saved === 'light' || saved === 'dark' ? saved : DEFAULT_THEME;
  return (
    // data-skin is set here rather than from a client effect: the first paint has to
    // be the reading paper, or every reload flashes the wrong background.
    <div className="nx" data-theme={theme} data-skin="ink">
      <ThemeSync theme={theme} />
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />
      <Providers>{children}</Providers>
    </div>
  );
}

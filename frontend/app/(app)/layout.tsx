import type { ReactNode } from 'react';
import '../app.css';
import Providers from '@/components/providers';

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

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="nx">
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />
      <Providers>{children}</Providers>
    </div>
  );
}

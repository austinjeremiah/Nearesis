import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import WebflowRuntime from '@/components/WebflowRuntime';

const TITLE = "Nearesis – Research you can rerun.";
const DESCRIPTION =
  'Nearesis is a living-thesis workspace for NEAR: certified queries, executable panels, markers that dispatch agents, and a thesis anyone can rebuild offline from a frozen snapshot.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website' },
  twitter: { title: TITLE, description: DESCRIPTION, card: 'summary_large_image' },
  icons: {
    icon: [
      { url: '/assets/6a9017ffbec05cea75b003a3_favicon.jpg', type: 'image/png', sizes: '32x32', media: '(prefers-color-scheme: light)' },
      { url: '/assets/6a9017ffbec05cea75b003a3_favicon.jpg', type: 'image/png', sizes: '32x32', media: '(prefers-color-scheme: dark)' },
      { url: '/assets/6a9017ffe18b75aa9bb0ae7f_favicon.jpg', type: 'image/png', sizes: '48x48' },
      { url: '/assets/6a9017ff536fd94c3e01ea9a_favicon.jpg', type: 'image/png', sizes: '192x192' },
      { url: '/assets/6a9017ff9e1be6ec772784d7_favicon.jpg', type: 'image/png', sizes: '512x512' },
    ],
    apple: [{ url: '/assets/6a9017ff8adac152a38892e5_favicon.jpg', sizes: '180x180' }],
  },
};

// Webflow shipped these two faces through its WebFont.js loader. They are requested as a
// plain stylesheet instead: same families and weights, one less render-blocking script,
// and no <head> script tag for a browser extension's injected one to collide with during
// hydration. w-mod-js moved to <html> in app/layout.tsx; w-mod-touch is set in
// WebflowRuntime, since it only toggles background-attachment.
const GOOGLE_FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@100;200;300;400;500;600;700;800;900' +
  '&family=Stack+Sans+Notch:wght@200;300;400;500;600;700' +
  '&display=swap';

// The marketing site owns the Webflow stylesheets and runtime; the app routes (app/(app)) do not load them.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link href="/css/avande.webflow.css" rel="stylesheet" type="text/css" precedence="default" />
      <link href="/css/ix-initial-state.css" rel="stylesheet" type="text/css" precedence="default" />
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={GOOGLE_FONTS} rel="stylesheet" type="text/css" precedence="default" />
      {children}
      <WebflowRuntime />
    </>
  );
}

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import WebflowRuntime from '@/components/WebflowRuntime';

const TITLE = "Klero – Agents fork. Money doesn't.";
const DESCRIPTION =
  'Klero is the exactly-once layer for AI agent payments: x402 on Hedera, one winner per job decided by HCS consensus, payment intents that die after 120 seconds, and World ID approval for the actions that matter.';

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

// Same two inline scripts Webflow puts in <head>: load the Google fonts, and flag
// <html> with w-mod-js so ix-initial-state.css can hide elements until IX3 boots.
const WEBFONT_LOAD =
  'WebFont.load({  google: {    families: ["Inter Tight:100,200,300,400,500,600,700,800,900","Stack Sans Notch:200,300,400,500,600,700"]  }});';
const W_MOD =
  '!function(o,c){var n=c.documentElement,t=" w-mod-";n.className+=t+"js",("ontouchstart"in o||o.DocumentTouch&&c instanceof DocumentTouch)&&(n.className+=t+"touch")}(window,document);';

// The marketing site owns the Webflow stylesheets and runtime; the app routes (app/(app)) do not load them.
export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <link href="/css/avande.webflow.css" rel="stylesheet" type="text/css" precedence="default" />
      <link href="/css/ix-initial-state.css" rel="stylesheet" type="text/css" precedence="default" />
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <script src="/js/webfont.js" type="text/javascript" />
      <script type="text/javascript" dangerouslySetInnerHTML={{ __html: WEBFONT_LOAD }} />
      <script type="text/javascript" dangerouslySetInnerHTML={{ __html: W_MOD }} />
      {children}
      <WebflowRuntime />
    </>
  );
}

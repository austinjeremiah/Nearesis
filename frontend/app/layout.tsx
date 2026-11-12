import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Klero — Agents fork. Money doesn’t.',
  description: 'The exactly-once payment layer for AI agents. Hedera x402 · World ID Agent Pass.',
  icons: { apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#f1efe2', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The Webflow runtime adds classes to <html>, so hydration warnings are expected.
    <html data-wf-page="6a901794a3ca5e0a74527ddb" data-wf-site="6a901794a3ca5e0a74527dde" lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

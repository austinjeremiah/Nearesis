import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Nearesis — Research you can rerun.',
  description: 'A living-thesis workspace for NEAR. Certified metrics · executable panels · offline rebuilds.',
  icons: { apple: '/apple-touch-icon.png' },
};
export const viewport: Viewport = { themeColor: '#f1efe2', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The Webflow runtime adds classes to <html>, so hydration warnings are expected.
    // w-mod-js is rendered here rather than set by an inline script: ix-initial-state.css
    // keys off it to hide animated elements until IX3 boots, and shipping it in the HTML
    // avoids both a flash and a <head> script for an extension to collide with.
    <html
      data-wf-page="6a901794a3ca5e0a74527ddb"
      data-wf-site="6a901794a3ca5e0a74527dde"
      lang="en"
      className="w-mod-js"
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  );
}

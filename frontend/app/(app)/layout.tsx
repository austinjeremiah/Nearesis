import type { ReactNode } from 'react';
import '../app.css';
import { AppProviders } from '@/components/app/providers';

// The app routes do not load the marketing site's Webflow stylesheet or runtime (see app/(site)/layout.tsx).
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="sp">
      <link
        href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700&family=Stack+Sans+Notch:wght@300;400;500;600&display=swap"
        rel="stylesheet"
        precedence="default"
      />
      <AppProviders>{children}</AppProviders>
    </div>
  );
}

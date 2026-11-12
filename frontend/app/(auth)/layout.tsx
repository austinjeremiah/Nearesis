import type { ReactNode } from 'react';
import '../app.css';

/**
 * Auth route group. Spec 5.1: a branded sparse page, not a dashboard behind a
 * blurred overlay, because a blurred shell implies data the visitor cannot see
 * and may not have.
 */
const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@300;400;500;600;700' +
  '&family=Stack+Sans+Notch:wght@300;400;500;600' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="nx">
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />
      <div className="auth-page">{children}</div>
    </div>
  );
}

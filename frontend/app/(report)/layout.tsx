import type { ReactNode } from 'react';
import '../app.css';
import '@/components/report/report.css';

/**
 * Print report route group. Same fonts and tokens as the app, but no application frame and no theme: the report is always
 * light, whatever the reader's theme cookie says, because it is meant for paper and PDF.
 */
const FONTS =
  'https://fonts.googleapis.com/css2' +
  '?family=Inter+Tight:wght@300;400;500;600;700' +
  '&family=Stack+Sans+Notch:wght@300;400;500;600' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

export default function ReportGroupLayout({ children }: { children: ReactNode }) {
  return (
    <div className="nx rp-root" data-theme="light">
      <link href="https://fonts.googleapis.com" rel="preconnect" />
      <link href="https://fonts.gstatic.com" rel="preconnect" crossOrigin="anonymous" />
      <link href={FONTS} rel="stylesheet" precedence="default" />
      {children}
    </div>
  );
}

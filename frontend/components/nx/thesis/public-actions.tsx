'use client';

import './thesis.css';
import { Download, FileText, Printer } from 'lucide-react';
import { Button } from '@/components/nx/ui';
import { publicDocHref } from '@/lib/thesis/document';

/** Read-only actions for the public thesis page. No sign-in is needed for any of them except the first. */
export default function PublicActions({ slug, openHref, signedIn }: { slug: string; openHref: string; signedIn: boolean }) {
  return (
    <div className="th-actions" data-testid="thesis-public-actions">
      <div className="th-actions-row">
        <a className="btn primary" href={openHref} data-testid="thesis-open-in-account">
          Open in my account
        </a>
        <a className="btn" href={`/api/public/theses/${encodeURIComponent(slug)}/files/THESIS.md`} download data-testid="thesis-download-md">
          <Download size={14} /> THESIS.md
        </a>
        <a className="btn" href={publicDocHref(slug)} data-testid="thesis-public-document">
          <FileText size={14} /> Document view
        </a>
        <Button onClick={() => window.print()} data-testid="thesis-print">
          <Printer size={14} /> Print or save as PDF
        </Button>
      </div>
      <p className="th-hint">
        {signedIn
          ? 'Opening it adds a copy to your Theses list, where you can verify it for free or reproduce it with your own credits.'
          : 'Sign in to add it to your account, verify it for free, or reproduce it with your own credits. Reading needs no account.'}
      </p>
    </div>
  );
}

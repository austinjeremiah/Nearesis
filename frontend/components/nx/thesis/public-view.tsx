'use client';

import { ThesisDocView } from '@/components/nx/thesis-track/thesis-view';
import { receiptsText, type Receipts } from '@/lib/thesis/list';
import type { Thesis } from '@/lib/thesis-track/model';
import PublicActions from './public-actions';

/** The one viewer, read-only, for a thesis read from its public link. */
export default function PublicThesisView({ doc, slug, receipts, openHref, signedIn }: { doc: Thesis; slug: string; receipts: Receipts | null; openHref: string; signedIn: boolean }) {
  return (
    <ThesisDocView
      doc={doc}
      publication="published"
      receiptsLine={receipts ? receiptsText(receipts) : null}
      actions={<PublicActions slug={slug} openHref={openHref} signedIn={signedIn} />}
    />
  );
}

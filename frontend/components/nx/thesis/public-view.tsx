'use client';

import { ThesisDocView } from '@/components/nx/thesis-track/thesis-view';
import { receiptsText, type Receipts } from '@/lib/thesis/list';
import type { Thesis } from '@/lib/thesis-track/model';
import type { Strength } from '@/lib/thesis/strength';
import type { Challenge } from '@/lib/thesis/challenge';
import PublicActions from './public-actions';

/** The one viewer, read-only, for a thesis read from its public link. */
export default function PublicThesisView({ doc, slug, receipts, openHref, signedIn, strength = null, challenges = [] }: { doc: Thesis; slug: string; receipts: Receipts | null; openHref: string; signedIn: boolean; strength?: Strength | null; challenges?: Challenge[] }) {
  return (
    <ThesisDocView
      doc={doc}
      publication="published"
      receiptsLine={receipts ? receiptsText(receipts) : null}
      strength={strength}
      strengthInline
      challenges={{ items: challenges, thesisId: null, owner: false, show: false }}
      actions={<PublicActions slug={slug} openHref={openHref} signedIn={signedIn} />}
    />
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadPublicThesis } from '@/lib/thesis/public';
import ThesisDocument from '@/components/report/thesis-document';
import type { DocMeta } from '@/lib/thesis/document';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Shared thesis document · Nearesis', robots: { index: false } };

/**
 * `/t/<slug>/document`: the published thesis as the same A4 document, read-only and without sign-in. Fetched server-side
 * from the public API like `/t/<slug>`; "Print or save as PDF" uses the browser's own print.
 */
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  let slug = raw;
  try {
    slug = decodeURIComponent(raw);
  } catch {
    /* keep the raw segment */
  }
  const o = await loadPublicThesis(slug);
  if (o.kind === 'not_found') notFound();
  if (o.kind !== 'ok') {
    const msg = o.kind === 'rate_limited' ? `Too many requests. Try again${o.retryAfter ? ` in ${o.retryAfter} seconds` : ' shortly'}.` : o.message;
    return (
      <main className="rp-error" data-thesis-error={o.kind} data-testid="public-thesis-doc-error">
        <h1>The thesis could not be shown</h1>
        <p>{msg}</p>
      </main>
    );
  }
  const meta: DocMeta = { id: o.thesisId ?? slug, kind: 'workspace', owner: null, strength: o.strength, receipts: o.receipts, challenges: o.challenges, published: true };
  return <ThesisDocument doc={o.doc} meta={meta} mode="public" slug={slug} />;
}

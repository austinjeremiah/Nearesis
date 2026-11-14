import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverTransport } from '@/lib/api/server';
import { requestJson } from '@/lib/api/transport';
import { settle } from '@/lib/api/guard';
import { normalizeDoc } from '@/lib/thesis/doc';
import { REFERENCE_ID } from '@/lib/thesis/list';
import ThesisPrint from '@/components/nx/thesis/thesis-print';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Nearesis thesis', robots: { index: false } };

/**
 * `/thesis-print/<id>`: the thesis as an A4 print layout, rendered from the reader's own session. Only the PDF route loads
 * it; the root carries `data-thesis-ready="true"` once every chart is drawn. The reference thesis falls back to
 * `GET /v1/thesis` until the thesis API serves it.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  let r = await settle(requestJson<{ doc?: unknown }>(serverTransport, `/v1/theses/${encodeURIComponent(id)}`));
  let docRaw: unknown = r.ok ? r.data?.doc : null;
  if (!r.ok && id === REFERENCE_ID && (r.error.kind === 'not_found' || r.error.status === 405)) {
    const legacy = await settle(requestJson<unknown>(serverTransport, '/v1/thesis'));
    if (legacy.ok) docRaw = legacy.data;
    else r = legacy as typeof r;
  }
  if (!docRaw) {
    if (!r.ok && r.error.kind === 'not_found') notFound();
    const code = !r.ok ? (r.error.reasonCode ?? r.error.errorCode) : 'THESIS_UNREADABLE';
    return (
      <main className="rp-error" data-thesis-error={code}>
        <h1>The thesis could not be built</h1>
        <p className="rp-mono">{code}</p>
      </main>
    );
  }
  const doc = normalizeDoc(docRaw);
  if (!doc) return <main className="rp-error" data-thesis-error="THESIS_UNREADABLE"><h1>The thesis could not be read</h1></main>;
  return <ThesisPrint doc={doc} isReference={id === REFERENCE_ID} title={(doc.hypothesis ?? 'Thesis').slice(0, 140)} />;
}

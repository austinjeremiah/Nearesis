import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverTransport } from '@/lib/api/server';
import { requestJson } from '@/lib/api/transport';
import { settle } from '@/lib/api/guard';
import { normalizeDoc } from '@/lib/thesis/doc';
import { REFERENCE_ID, normalizeReceipts, normalizeSummary, referenceSummary } from '@/lib/thesis/list';
import { normalizeChallenges } from '@/lib/thesis/challenge';
import { normalizeStrength } from '@/lib/thesis/strength';
import ThesisDocument from '@/components/report/thesis-document';
import type { DocMeta } from '@/lib/thesis/document';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Nearesis thesis document', robots: { index: false } };

type Bundle = { thesis?: unknown; doc?: unknown; receipts?: unknown; challenges?: unknown };

/**
 * `/thesis/<id>/document`: the thesis as an A4 document in the workspace report's design. Server-rendered from
 * `GET /v1/theses/:id` with the reader's own session (the reference thesis falls back to `GET /v1/thesis` until the thesis
 * API serves it); the charts are drawn in the browser and the root carries `data-report-ready="true"` once every chart is
 * drawn. The PDF route loads this page. A thesis the reader cannot open is the usual 404.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);
  let r = await settle(requestJson<Bundle>(serverTransport, `/v1/theses/${encodeURIComponent(id)}`));
  let body: Bundle | null = r.ok ? r.data : null;
  if (!r.ok && id === REFERENCE_ID && (r.error.kind === 'not_found' || r.error.status === 405)) {
    const legacy = await settle(requestJson<unknown>(serverTransport, '/v1/thesis'));
    if (legacy.ok) body = { doc: legacy.data };
    else r = legacy as typeof r;
  }
  if (!body?.doc) {
    if (!r.ok && r.error.kind === 'not_found') notFound();
    const code = !r.ok ? (r.error.reasonCode ?? r.error.errorCode) : 'THESIS_UNREADABLE';
    return (
      <main className="rp-error" data-thesis-error={code}>
        <h1>The thesis could not be built</h1>
        <p className="rp-mono">{code}</p>
      </main>
    );
  }
  const doc = normalizeDoc(body.doc);
  if (!doc) return <main className="rp-error" data-thesis-error="THESIS_UNREADABLE"><h1>The thesis could not be read</h1></main>;
  const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const summary = normalizeSummary(body.thesis) ?? { ...referenceSummary(doc), id, kind: id === REFERENCE_ID ? ('reference' as const) : ('workspace' as const) };
  const t = rec(body.thesis);
  const kind = id === REFERENCE_ID ? 'reference' : summary.kind;
  // The reader owns the theses in their own list; the reference belongs to nobody and an opened-from-link copy names no owner.
  let owner: string | null = null;
  if (kind === 'workspace') {
    const me = await settle(requestJson<{ principal?: { displayName?: string } }>(serverTransport, '/v1/me'));
    if (me.ok) owner = me.data?.principal?.displayName ?? null;
  }
  const meta: DocMeta = {
    id,
    kind,
    owner,
    strength: summary.strength ?? normalizeStrength(t?.strength),
    receipts: body.thesis || body.receipts ? normalizeReceipts(t?.receipts ?? body.receipts) : null,
    challenges: normalizeChallenges(body.challenges ?? t?.challenges),
    published: summary.published,
  };
  return <ThesisDocument doc={doc} meta={meta} />;
}

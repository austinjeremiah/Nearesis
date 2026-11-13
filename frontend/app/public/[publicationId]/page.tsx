import '../../app.css';
import { API_URL } from '@/lib/api/config';
import { Badge } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import { LocalBadge, OutlayerBadge } from '@/components/ws6/capsule-bits';
import { PublicationVersionCard, type PublicationVersion } from '@/components/ws8/publication-trust';
import { ExportLinks } from './export-links';
import type { CapsuleView } from '@/lib/ws6/api';
import { formatUtc, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

type PublicPublication = Pick<CapsuleView, 'title' | 'claims' | 'results' | 'hashes' | 'verification' | 'capsuleId'> & {
  label: string;
  createdAt: string | null;
  state: 'published';
  publishedAt: string;
  badge: string;
  acknowledgedCautions: string[];
  documents: { path: string; sha256: string; url: string }[];
  versions: PublicationVersion[];
};

type Outcome =
  | { kind: 'ok'; data: PublicPublication }
  | { kind: 'withdrawn' }
  | { kind: 'not_found' }
  | { kind: 'rate_limited'; retryAfter: string | null }
  | { kind: 'unavailable'; message: string };

/**
 * Anonymous read of the public publication endpoint. This is a server-to-server call that carries NO cookie and
 * NO authorization header, so what renders is what any anonymous reader gets. Nothing about an unpublished or
 * withdrawn capsule is shown.
 */
async function load(id: string): Promise<Outcome> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}/v1/public/publications/${encodeURIComponent(id)}`, { cache: 'no-store', headers: { accept: 'application/json' } });
  } catch {
    return { kind: 'unavailable', message: 'The publication service is not reachable.' };
  }
  if (r.ok) return { kind: 'ok', data: (await r.json()) as PublicPublication };
  const body = (await r.json().catch(() => ({}))) as { reasonCode?: string; message?: string };
  if (r.status === 404) return body.reasonCode === 'PUBLICATION_WITHDRAWN' ? { kind: 'withdrawn' } : { kind: 'not_found' };
  if (r.status === 429) return { kind: 'rate_limited', retryAfter: r.headers.get('retry-after') };
  return { kind: 'unavailable', message: body.message ?? `The publication could not be read (HTTP ${r.status}).` };
}

export default async function PublicPublicationPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const id = decodeURIComponent(publicationId);
  const wrap = (children: React.ReactNode) => (
    <div className="nx" style={{ maxWidth: 860, margin: '0 auto', padding: '8vh 24px' }}>
      {children}
    </div>
  );
  const o = await load(id);
  if (o.kind === 'withdrawn')
    return wrap(
      <div data-testid="public-withdrawn" data-state="withdrawn">
        <EmptyState title="This publication was withdrawn" body="Its owner withdrew it, so it is no longer public. Nothing from it is shown." />
      </div>,
    );
  if (o.kind === 'not_found')
    return wrap(
      <div data-testid="public-not-found" data-state="not_found">
        <EmptyState title="Publication not found" body="No capsule has been published under this id." />
      </div>,
    );
  if (o.kind === 'rate_limited')
    return wrap(
      <div data-testid="public-rate-limited" data-state="rate_limited">
        <EmptyState title="Too many requests" body={`Try again${o.retryAfter ? ` in ${o.retryAfter} seconds` : ' shortly'}.`} />
      </div>,
    );
  if (o.kind === 'unavailable')
    return wrap(
      <div data-testid="public-unavailable" data-state="source_unavailable">
        <EmptyState title="Publication unavailable" body={o.message} />
      </div>,
    );
  const c = o.data;
  const latest = c.versions[c.versions.length - 1] ?? null;
  const limitations = c.label === 'SYNTHETIC' ? ['This capsule is built from SYNTHETIC data. No statement here describes NEAR production activity.'] : [];
  return wrap(
    <div className="col gap4" data-testid="public-publication" data-capsule={c.capsuleId}>
      <div className="row gap2">
        <Badge tone="ok">published</Badge>
        <Badge outline>{c.badge}</Badge>
        <Badge tone={c.label === 'SYNTHETIC' ? 'warn' : 'info'} outline>{c.label}</Badge>
      </div>
      <h1 className="h2">{c.title}</h1>
      {c.label === 'SYNTHETIC' && <Notice tone="warn" title="Synthetic data">No statement here describes NEAR production activity.</Notice>}
      {c.acknowledgedCautions.length > 0 && (
        <Notice tone="warn" title="Published with acknowledged cautions">
          The publisher acknowledged: {c.acknowledgedCautions.join(', ')}.
        </Notice>
      )}
      <Card title="Verification">
        <div className="row gap2">
          <LocalBadge v={c.verification.local} />
          <OutlayerBadge v={c.verification.outlayer} />
        </div>
        <KeyValues
          rows={[
            { k: 'Published', v: <span className="mono">{formatUtc(c.publishedAt)}</span> },
            { k: 'Result manifest', v: <span className="mono" title={c.hashes.resultManifestHash ?? ''}>{c.hashes.resultManifestHash ? shortHash(c.hashes.resultManifestHash, 10, 6) : 'none'}</span> },
          ]}
        />
        {c.verification.failures.length > 0 && <p className="small" data-testid="public-failures">Local verification recorded {c.verification.failures.length} failure(s). The capsule is published as unverified.</p>}
      </Card>
      <Card title="Signing key and anchor">
        {latest ? <PublicationVersionCard v={latest} testId="public-trust" /> : <p className="small dim" data-testid="public-no-version">No signed version is recorded for this publication.</p>}
      </Card>
      <Card title="Claims">
        <ul className="col gap2">
          {c.claims.map((x) => (
            <li key={x.id} className="small">
              <Badge outline>{x.claimClass.replace(/_/g, ' ')}</Badge> {x.text}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Results">
        <ul className="col gap2">
          {c.results.map((x) => (
            <li key={x.id} className="small"><span className="strong">{x.label}</span>: <span className="mono">{x.value}</span> {x.unit}</li>
          ))}
        </ul>
      </Card>
      <Card title="Limitations">
        <ul className="col gap2" data-testid="public-limitations">
          {limitations.map((l, i) => (
            <li key={i} className="small">{l}</li>
          ))}
          <li className="small">Results are reproducible only from the frozen snapshot named by the capsule hashes; they do not describe data after it.</li>
        </ul>
      </Card>
      <Card title="Documents" subtitle="Downloaded without a session; each is checked against its listed SHA-256.">
        <ExportLinks id={c.capsuleId} docs={c.documents} />
      </Card>
    </div>,
  );
}

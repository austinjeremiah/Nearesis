import '../../app.css';
import { api } from '@/lib/api/server';
import { settle } from '@/lib/api/guard';
import { ApiRequestError } from '@/lib/api/errors';
import { sessionToken } from '@/lib/api/server';
import { Badge } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import { LocalBadge, OutlayerBadge } from '@/components/ws6/capsule-bits';
import type { CapsuleResponse, PublicationRecord } from '@/lib/ws6/api';
import { formatUtc, shortHash } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Public reader for a published capsule. It shows a capsule only while it is published, with its limitations and the
 * two verification claims kept apart. The API has no unauthenticated publication read route yet, so the page reads
 * through a signed-in session and says so plainly when there is none; it never renders anything for an unpublished capsule.
 */
export default async function PublicPublicationPage({ params }: { params: Promise<{ publicationId: string }> }) {
  const { publicationId } = await params;
  const id = decodeURIComponent(publicationId);
  const wrap = (children: React.ReactNode) => (
    <div className="nx" style={{ maxWidth: 820, margin: '0 auto', padding: '8vh 24px' }}>
      {children}
    </div>
  );
  if (!(await sessionToken())) {
    return wrap(
      <div data-testid="public-needs-reader" data-state="source_unavailable">
        <EmptyState
          title="This publication cannot be read anonymously yet"
          body="The public read endpoint for published capsules is not available on the API, so nothing is shown here without a signed-in reader. Sign in to read a publication your organisation owns."
        />
        <p className="small" style={{ textAlign: 'center' }}>
          <a className="link" href={`/login?next=${encodeURIComponent(`/public/${id}`)}`}>Sign in</a>
        </p>
      </div>,
    );
  }
  const pubR = await settle(api.get<PublicationRecord>(`/v1/capsules/${encodeURIComponent(id)}/publication`));
  if (!pubR.ok) {
    const nf = pubR.error instanceof ApiRequestError && pubR.error.kind === 'not_found';
    return wrap(
      <div data-testid="public-not-found">
        <EmptyState title={nf ? 'Publication not found' : 'Publication unavailable'} body={nf ? 'No published capsule has this id, or you do not have access to it.' : pubR.error.message} />
      </div>,
    );
  }
  if (!pubR.data.public) {
    return wrap(
      <div data-testid="public-withdrawn" data-state={pubR.data.record?.state ?? 'never_published'}>
        <EmptyState title="Not published" body={pubR.data.record?.state === 'unpublished' ? 'This capsule was withdrawn by its owner and is no longer public.' : 'This capsule has not been published.'} />
      </div>,
    );
  }
  const capR = await settle(api.get<CapsuleResponse>(`/v1/capsules/${encodeURIComponent(id)}`));
  if (!capR.ok || capR.data.status !== 'available') {
    return wrap(<EmptyState title="Publication unavailable" body={capR.ok && capR.data.status === 'unavailable' ? capR.data.reason : 'The capsule could not be read.'} />);
  }
  const c = capR.data.capsule;
  const rec = pubR.data.record;
  return wrap(
    <div className="col gap4" data-testid="public-publication">
      <div className="row gap2">
        <Badge tone="ok">published</Badge>
        {rec?.badge && <Badge outline>{rec.badge}</Badge>}
        <Badge tone={c.sourceLabel === 'SYNTHETIC' ? 'warn' : 'info'} outline>{c.sourceLabel}</Badge>
      </div>
      <h1 className="h2">{c.title}</h1>
      {c.sourceLabel === 'SYNTHETIC' && <Notice tone="warn" title="Synthetic data">No statement here describes NEAR production activity.</Notice>}
      {rec && rec.acknowledged.length > 0 && (
        <Notice tone="warn" title="Published with acknowledged cautions" >
          The publisher acknowledged: {rec.acknowledged.join(', ')}.
        </Notice>
      )}
      <Card title="Verification">
        <div className="row gap2">
          <LocalBadge v={c.verification.local} />
          <OutlayerBadge v={c.verification.outlayer} />
        </div>
        <KeyValues
          rows={[
            { k: 'Published', v: <span className="mono">{formatUtc(rec?.at ?? null)}</span> },
            { k: 'Result manifest', v: <span className="mono" title={c.hashes.resultManifestHash ?? ''}>{c.hashes.resultManifestHash ? shortHash(c.hashes.resultManifestHash, 10, 6) : 'none'}</span> },
          ]}
        />
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
      <Card title="Limitations">
        <ul className="col gap2" data-testid="public-limitations">
          {c.limitations.map((l, i) => (
            <li key={i} className="small">{l}</li>
          ))}
        </ul>
      </Card>
    </div>,
  );
}

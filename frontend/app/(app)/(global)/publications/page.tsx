import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

/** Spec 5.25 — publication library. */
export default function PublicationsPage() {
  const rows = db.publications();

  return (
    <>
      <PageHeader
        title="Publications"
        description="Frozen, citable versions. Each one opens without credentials."
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        {rows.length === 0 ? (
          <EmptyState title="Nothing published yet" />
        ) : (
          <div className="col gap4">
            {rows.map((p) => {
              const cap = db.capsule(p.capsuleHash);
              return (
                <Card
                  key={p.id}
                  title={<Link href={`/public/${p.id}`}>{p.title}</Link>}
                  subtitle={`Version ${p.version}`}
                  actions={<EvidenceVerdict verdict={p.verdict} strength={p.strength} />}
                  footer={
                    <>
                      <span className="tiny dim mono">{formatUtc(p.publishedAt)}</span>
                      <div className="grow" />
                      <Link className="link small" href={`/public/${p.id}`}>
                        Open public reader
                      </Link>
                    </>
                  }
                >
                  <KeyValues
                    rows={[
                      { k: 'Snapshot', v: <span className="mono">{p.snapshotId}</span> },
                      { k: 'Capsule', v: <span className="mono">{shortHash(p.capsuleHash)}</span> },
                      {
                        k: 'Verification',
                        v: cap ? (
                          <span className="row gap2 wrap">
                            <Badge tone={cap.reproducible ? 'ok' : 'bad'}>
                              {cap.reproducible ? 'Reproducible' : 'Rebuild failed'}
                            </Badge>
                            <Badge tone={cap.inputIntegrity ? 'ok' : 'bad'}>
                              {cap.inputIntegrity ? 'Inputs verified' : 'Input mismatch'}
                            </Badge>
                            <Badge tone={cap.attestation === 'verified' ? 'ok' : ''}>
                              Attestation {cap.attestation}
                            </Badge>
                          </span>
                        ) : (
                          <span className="unavailable" />
                        ),
                      },
                      { k: 'Visibility', v: p.public ? 'Public' : 'Organization only' },
                    ]}
                  />
                </Card>
              );
            })}
          </div>
        )}

        <Notice tone="info" title="A version is never overwritten">
          A nightly refresh produces a new version with its own snapshot and digest. The old one
          stays readable, so a citation does not silently change meaning after it was made.
        </Notice>
      </Content>
    </>
  );
}

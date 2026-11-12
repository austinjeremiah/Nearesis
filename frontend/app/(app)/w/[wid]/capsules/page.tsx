import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.24 — capsule library.
 *
 * Three verification claims, kept separate. Reproducible means a rebuild
 * produced identical outputs. Input integrity means the raw payload hashes
 * match the manifest. Attestation means an enclave vouched for which code ran.
 * Merging them into one tick would let the weakest pass as the strongest.
 */
export default async function CapsulesPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.capsules(wid);

  return (
    <>
      <PageHeader
        title="Capsules"
        description="Sealed research packages that rebuild offline, with no credentials."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Capsules' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        {rows.length === 0 ? (
          <EmptyState title="No capsules yet" body="A capsule is sealed when a thesis version is built." />
        ) : (
          <div className="col gap4">
            {rows.map((c) => (
              <Card
                key={c.hash}
                title={<Link href={`/w/${wid}/capsules/${c.hash}`}>Version {c.version}</Link>}
                subtitle={`${c.sizeMb.toFixed(1)} MB · ${c.files.length} files`}
                actions={
                  <>
                    <Badge tone={c.reproducible ? 'ok' : 'bad'}>
                      {c.reproducible ? 'Reproducible' : 'Rebuild failed'}
                    </Badge>
                    <Badge tone={c.inputIntegrity ? 'ok' : 'bad'}>
                      {c.inputIntegrity ? 'Inputs verified' : 'Input mismatch'}
                    </Badge>
                    <Badge
                      tone={c.attestation === 'verified' ? 'ok' : c.attestation === 'failed' ? 'bad' : ''}
                      title={
                        c.attestation === 'unavailable'
                          ? 'No external attestation was produced. A local rebuild is not an attestation.'
                          : undefined
                      }
                    >
                      Attestation {c.attestation}
                    </Badge>
                  </>
                }
                footer={
                  <>
                    <span className="tiny dim mono">{shortHash(c.hash)}</span>
                    <div className="grow" />
                    <span className="tiny dim">{formatUtc(c.createdAt)}</span>
                  </>
                }
              >
                <KeyValues
                  rows={[
                    { k: 'Snapshot', v: <span className="mono">{c.snapshotId}</span> },
                    { k: 'Rebuild command', v: <span className="mono">pnpm research:rebuild --snapshot {c.snapshotId}</span> },
                  ]}
                />
                {c.attestation === 'unavailable' && (
                  <Notice tone="info" title="Reproducible locally. External compute attestation not available.">
                    The rebuild matched byte for byte on this machine. That proves the pipeline is
                    deterministic, not that it ran inside a trusted enclave, and not that the
                    source data described reality.
                  </Notice>
                )}
              </Card>
            ))}
          </div>
        )}
      </Content>
    </>
  );
}

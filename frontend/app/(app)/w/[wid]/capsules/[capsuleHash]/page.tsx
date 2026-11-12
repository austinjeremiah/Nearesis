import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/** Spec 5.24 — capsule detail: manifest, verification receipt, file list. */
export default async function CapsuleDetailPage({
  params,
}: {
  params: Promise<{ wid: string; capsuleHash: string }>;
}) {
  const { wid, capsuleHash } = await params;
  const ws = db.workspace(wid);
  const c = db.capsule(capsuleHash);

  if (!ws || !c) {
    return (
      <Content>
        <EmptyState
          title="Capsule not found"
          body="That capsule does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/capsules`}>Back to capsules</LinkButton>}
        />
      </Content>
    );
  }

  return (
    <>
      <PageHeader
        title={`Capsule ${c.version}`}
        description="Everything needed to rebuild this thesis without our backend."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Capsules', href: `/w/${wid}/capsules` },
          { label: c.version },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={c.createdAt} />}
        actions={
          <Button disabled disabledReason="Downloading a capsule needs the authorized API.">
            Download
          </Button>
        }
      />
      <Content>
        <div className="grid c3">
          <Card title="Reproducible" actions={<Badge tone={c.reproducible ? 'ok' : 'bad'}>{c.reproducible ? 'Pass' : 'Fail'}</Badge>}>
            <p className="small muted">
              A clean rebuild from the frozen inputs produced identical tables and charts.
            </p>
            <span className="tiny dim">Claim: the pipeline is deterministic.</span>
          </Card>
          <Card title="Input integrity" actions={<Badge tone={c.inputIntegrity ? 'ok' : 'bad'}>{c.inputIntegrity ? 'Pass' : 'Fail'}</Badge>}>
            <p className="small muted">
              Every raw payload hash matches the manifest recorded at retrieval time.
            </p>
            <span className="tiny dim">Claim: the inputs were not altered after capture.</span>
          </Card>
          <Card
            title="Attestation"
            actions={
              <Badge tone={c.attestation === 'verified' ? 'ok' : c.attestation === 'failed' ? 'bad' : ''}>
                {c.attestation}
              </Badge>
            }
          >
            <p className="small muted">
              {c.attestation === 'verified'
                ? 'An enclave vouched for which code ran on which inputs.'
                : 'No external attestation was produced for this capsule.'}
            </p>
            <span className="tiny dim">Claim: a specific binary processed specific inputs.</span>
          </Card>
        </div>

        <Notice tone="info" title="Three claims, not one">
          None of these establishes that the source data described reality. A deterministic
          pipeline can faithfully reproduce a wrong input, and an enclave can faithfully attest to
          it. That is why they are reported separately and why the limitations section exists.
        </Notice>

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Manifest">
            <KeyValues
              rows={[
                { k: 'Capsule hash', v: <span className="mono" style={{ wordBreak: 'break-all' }}>{c.hash}</span> },
                { k: 'Version', v: <span className="mono">{c.version}</span> },
                { k: 'Snapshot', v: <span className="mono">{c.snapshotId}</span> },
                { k: 'Sealed', v: <span className="mono">{formatUtc(c.createdAt)}</span> },
                { k: 'Size', v: <span className="mono">{c.sizeMb.toFixed(1)} MB</span> },
                { k: 'Rebuild', v: <span className="mono">pnpm research:rebuild --snapshot {c.snapshotId}</span> },
                { k: 'Needs credentials', v: 'No. The offline rebuild never requires a partner JWT.' },
              ]}
            />
          </Card>

          <Card title="Contents">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Path</th>
                    <th className="n">Bytes</th>
                  </tr>
                </thead>
                <tbody>
                  {c.files.map((f) => (
                    <tr key={f.path}>
                      <td className="mono small">{f.path}</td>
                      <td className="n mono small">{f.bytes.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </Content>
    </>
  );
}

import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/**
 * Spec 5.22 — branches and merge review.
 *
 * A branch is how you test an alternative framing without contaminating the
 * parent claim. The column that matters is the verdict delta: a branch that
 * flips a verdict is the interesting one, and hiding that behind a diff of
 * panel positions would miss the point.
 */
export default async function BranchesPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.branches(wid);

  return (
    <>
      <PageHeader
        title="Branches"
        description="Test an alternative framing without changing the parent."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Branches' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <Button disabled disabledReason="Creating a branch needs the authorized API.">
            New branch
          </Button>
        }
      />
      <Content>
        {rows.length === 0 ? (
          <EmptyState title="No branches" body="The workspace has only its main line." />
        ) : (
          <div className="col gap4">
            {rows.map((b) => (
              <Card
                key={b.id}
                title={b.name}
                subtitle={b.description}
                actions={
                  b.name === 'main' ? (
                    <Badge tone="ok">Primary</Badge>
                  ) : b.verdictDelta && b.verdictDelta !== 'no change' ? (
                    <Badge tone="warn">Changes a verdict</Badge>
                  ) : (
                    <Badge outline>No verdict change</Badge>
                  )
                }
                footer={
                  <>
                    <span className="tiny dim mono">
                      {b.author} · {formatUtc(b.createdAt)}
                    </span>
                    <div className="grow" />
                    <Button disabled disabledReason="Comparing branches needs the authorized API.">
                      Compare with main
                    </Button>
                  </>
                }
              >
                <KeyValues
                  rows={[
                    { k: 'Based on', v: b.basedOn ? <span className="mono">{b.basedOn}</span> : <span className="unavailable" /> },
                    { k: 'Changed panels', v: <span className="mono">{b.changedPanels}</span> },
                    {
                      k: 'Verdict delta',
                      v: b.verdictDelta ? (
                        <span className={b.verdictDelta === 'no change' ? 'small dim' : 'small'} style={b.verdictDelta !== 'no change' ? { color: 'var(--warn)' } : undefined}>
                          {b.verdictDelta}
                        </span>
                      ) : (
                        <span className="unavailable" />
                      ),
                    },
                    { k: 'Data vintage', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
                  ]}
                />
              </Card>
            ))}
          </div>
        )}

        <Notice tone="info" title="A branch inherits the vintage, not a fresh pull">
          Comparing two branches is only meaningful if both ran on the same frozen data. A branch
          that silently refreshed its inputs would show a difference that came from the clock, not
          from the change being tested.
        </Notice>
      </Content>
    </>
  );
}

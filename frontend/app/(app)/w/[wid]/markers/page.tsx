import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/**
 * Spec 5.16 — markers.
 *
 * A marker is a selection that was deliberately kept: panel id, series, window
 * and filter hash, frozen at the moment it was made. That is what lets an agent
 * investigate the same interval the person was looking at, even after the chart
 * is resized or the lens changes.
 */
export default async function MarkersPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.markers(wid);

  return (
    <>
      <PageHeader
        title="Markers"
        description="Intervals you flagged, and what came back."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Markers' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={<LinkButton href={`/w/${wid}/canvas`}>Open canvas</LinkButton>}
      />
      <Content>
        <Notice tone="info" title="A marker is created on purpose">
          Hovering, clicking, zooming or dragging a range creates nothing. The selection stays
          ephemeral until you ask for a marker, and assigning an agent is a second, separate step.
        </Notice>

        {rows.length === 0 ? (
          <EmptyState
            title="No markers yet"
            body="Select a range on any chart and choose Investigate this interval."
            action={<LinkButton href={`/w/${wid}/canvas`} variant="primary">Open canvas</LinkButton>}
          />
        ) : (
          <div className="col gap4">
            {rows.map((m) => {
              const f = db.finding(m.findingId);
              const panel = db.panel(wid, m.panelId);
              return (
                <Card
                  key={m.id}
                  title={<Link href={`/w/${wid}/markers/${m.id}`}>{m.label}</Link>}
                  subtitle={panel?.title}
                  actions={
                    m.assignedTo ? (
                      <Badge outline>Assigned to {m.assignedTo}</Badge>
                    ) : (
                      <Badge tone="warn">Unassigned</Badge>
                    )
                  }
                  footer={
                    <>
                      <span className="tiny dim mono">Created {formatUtc(m.createdAt)}</span>
                      <div className="grow" />
                      {f ? (
                        <EvidenceVerdict verdict={f.verdict} />
                      ) : (
                        <Button disabled disabledReason="Assigning an agent needs the authorized API.">
                          Assign agent
                        </Button>
                      )}
                    </>
                  }
                >
                  <KeyValues
                    rows={[
                      {
                        k: 'Interval',
                        v: (
                          <span className="mono small">
                            {formatUtc(m.start, false)} to {formatUtc(m.end, false)}
                          </span>
                        ),
                      },
                      {
                        k: 'Panel',
                        v: panel ? (
                          <Link className="link" href={`/w/${wid}/panels/${panel.id}`}>
                            {panel.title}
                          </Link>
                        ) : (
                          <span className="unavailable" />
                        ),
                      },
                    ]}
                  />
                  {f && <p className="small muted">{f.summary}</p>}
                </Card>
              );
            })}
          </div>
        )}
      </Content>
    </>
  );
}

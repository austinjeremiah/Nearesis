import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Card, EmptyState, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/**
 * Spec 5.20 — research timeline.
 *
 * Every durable change appears here, which is what makes the record usable as
 * an audit trail. The actor label distinguishes a person from an agent from the
 * system, because "who decided this" is a different question from "what ran".
 */
export default async function TimelinePage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const events = db.timeline(wid);

  return (
    <>
      <PageHeader
        title="Timeline"
        description="Every durable change in this workspace, in order."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Timeline' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        {events.length === 0 ? (
          <EmptyState title="Nothing has happened yet" />
        ) : (
          <Card title={`${events.length} events`}>
            <ol className="col">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="row top gap4"
                  style={{ borderBottom: '1px dashed var(--line)', padding: '12px 0' }}
                >
                  <span className="tiny dim mono" style={{ minWidth: 150 }}>
                    {formatUtc(e.at)}
                  </span>
                  <Badge
                    outline
                    tone={e.actorKind === 'human' ? 'info' : e.actorKind === 'system' ? '' : 'ok'}
                  >
                    {e.actor}
                  </Badge>
                  <div className="grow col gap1">
                    <span className="small strong">
                      {e.href ? (
                        <Link className="link" href={e.href}>
                          {e.action}
                        </Link>
                      ) : (
                        e.action
                      )}
                    </span>
                    <span className="tiny dim">{e.detail}</span>
                  </div>
                  <span className="tiny mono dim">{e.id}</span>
                </li>
              ))}
            </ol>
          </Card>
        )}

        <Notice tone="info" title="What is not in this list">
          Hovering a chart, dragging a selection or opening a panel. Those change nothing durable,
          so recording them would bury the decisions that did.
        </Notice>
      </Content>
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/**
 * Spec 5.17 — monitors.
 *
 * Three properties the spec requires and this page states plainly: rules fire
 * on finalized observations only, a disabled rule runs no paid jobs at all, and
 * re-enabling does not replay a backlog as a burst of triggers.
 */
export default async function MonitorsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.monitors(wid);

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Deterministic rules over finalized observations. They wake an agent, they do not loop."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Monitors' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <Button disabled disabledReason="Creating a rule needs the authorized API.">
            New monitor
          </Button>
        }
      />
      <Content>
        <Notice tone="info" title="What a disabled monitor does">
          Nothing. No evaluation, no agent wake-up, no paid call. When it is re-enabled it resumes
          from the current watermark rather than catching up on everything it missed, so turning a
          rule back on cannot produce a burst of stale triggers.
        </Notice>

        {rows.length === 0 ? (
          <EmptyState title="No monitors yet" body="Attach a rule to a marker to watch for a meaningful change." />
        ) : (
          <div className="col gap4">
            {rows.map((m) => (
              <Card
                key={m.id}
                title={<Link href={`/w/${wid}/monitors/${m.id}`}>{m.name}</Link>}
                actions={
                  <>
                    {m.replayOnly && <Badge tone="warn">Replay</Badge>}
                    <Badge tone={m.enabled ? 'ok' : ''}>{m.enabled ? 'Enabled' : 'Disabled'}</Badge>
                  </>
                }
                footer={
                  <>
                    <span className="tiny dim">
                      {m.triggerCount} trigger{m.triggerCount === 1 ? '' : 's'} · {m.suppressed} suppressed as immaterial
                    </span>
                    <div className="grow" />
                    <Button disabled disabledReason="Toggling a rule needs the authorized API.">
                      {m.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </>
                }
              >
                <p className="small">{m.condition}</p>
                <KeyValues
                  rows={[
                    { k: 'Window', v: <span className="mono">{m.windowHours} hours</span> },
                    {
                      k: 'Marker',
                      v: m.markerId ? (
                        <Link className="link" href={`/w/${wid}/markers/${m.markerId}`}>
                          {m.markerId}
                        </Link>
                      ) : (
                        <span className="unavailable" />
                      ),
                    },
                    { k: 'Last triggered', v: <span className="mono">{formatUtc(m.lastTriggered)}</span> },
                    { k: 'Evaluates on', v: 'Finalized observations only. Provisional rows are ignored.' },
                  ]}
                />
                {m.replayOnly && (
                  <Notice tone="warn" title="Replay rule">
                    This rule runs against re-emitted historical events. Its triggers are labelled
                    REPLAY everywhere and are excluded from live counters.
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

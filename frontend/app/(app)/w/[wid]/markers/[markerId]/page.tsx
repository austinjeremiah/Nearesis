import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { PanelFrame } from '@/components/nx/panel';
import { Badge, DataModeIndicator, EvidenceVerdict } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc, shortHash } from '@/lib/format';

/**
 * Spec 5.16 — marker detail.
 *
 * The typed context the spec specifies is shown literally: panelId, seriesId,
 * start, end, filterHash, workspaceVersion. That tuple is what makes a finding
 * checkable, because a reviewer can reconstruct the exact view the question was
 * asked about.
 */
export default async function MarkerDetailPage({
  params,
}: {
  params: Promise<{ wid: string; markerId: string }>;
}) {
  const { wid, markerId } = await params;
  const ws = db.workspace(wid);
  const m = ws ? db.marker(wid, markerId) : undefined;

  if (!ws || !m) {
    return (
      <Content>
        <EmptyState
          title="Marker not found"
          body="That marker does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/markers`}>Back to markers</LinkButton>}
        />
      </Content>
    );
  }

  const panel = db.panel(wid, m.panelId);
  const f = db.finding(m.findingId);
  const result = panel ? db.resultFor(panel.metricIds) : null;

  return (
    <>
      <PageHeader
        title={m.label}
        description={`${formatUtc(m.start, false)} to ${formatUtc(m.end, false)} on ${panel?.title ?? 'a panel'}`}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Markers', href: `/w/${wid}/markers` },
          { label: m.label },
        ]}
        context={
          <>
            {m.assignedTo && <Badge outline>{m.assignedTo}</Badge>}
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <>
            <Button disabled disabledReason="Reassigning needs the authorized API.">
              Assign agent
            </Button>
            <LinkButton href={`/w/${wid}/monitors`}>Watch for a change</LinkButton>
          </>
        }
      />
      <Content>
        {panel && <PanelFrame panel={panel} workspaceId={wid} height={280} />}

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Selection context" subtitle="Frozen when the marker was created.">
            <KeyValues
              rows={[
                { k: 'panelId', v: <span className="mono">{m.panelId}</span> },
                { k: 'seriesId', v: <span className="mono">{panel?.metricIds[0] ?? '—'}</span> },
                { k: 'start', v: <span className="mono">{m.start}</span> },
                { k: 'end', v: <span className="mono">{m.end}</span> },
                {
                  k: 'filterHash',
                  v: <span className="mono">{result ? shortHash(result.query.canonicalQueryHash) : '—'}</span>,
                },
                { k: 'workspaceVersion', v: <span className="mono">12</span> },
                { k: 'snapshotId', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
              ]}
            />
            <p className="tiny dim">
              Resizing the chart, changing a lens or switching branch does not move this marker.
              It refers to data coordinates, not pixels.
            </p>
          </Card>

          <Card
            title="Finding"
            actions={f ? <EvidenceVerdict verdict={f.verdict} /> : <Badge tone="warn">Not investigated</Badge>}
          >
            {!f ? (
              <EmptyState
                title="No agent assigned yet"
                body="Assigning an agent is an explicit action with its own budget. Creating the marker did not start one."
              />
            ) : (
              <>
                <p className="small">{f.summary}</p>
                <KeyValues
                  rows={[
                    { k: 'By', v: <Badge outline>{f.by}</Badge> },
                    { k: 'At', v: <span className="mono">{formatUtc(f.at)}</span> },
                    {
                      k: 'Evidence',
                      v: f.evidenceResultIds.map((r) => (
                        <div key={r} className="mono small">
                          {r}
                        </div>
                      )),
                    },
                  ]}
                />
                <Notice tone="info" title="What the agent was allowed to do">
                  Read the certified measures already in this workspace scope and write one
                  finding. It could not widen its own scope, spawn a peer or spend past its grant.
                </Notice>
                <Link className="link small" href={`/w/${wid}/evidence`}>
                  Follow this into the evidence graph
                </Link>
              </>
            )}
          </Card>
        </div>
      </Content>
    </>
  );
}

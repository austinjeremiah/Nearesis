import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUtc } from '@/lib/format';

/** Spec 5.17 — monitor detail, with the rule, its history and its bounds. */
export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ wid: string; ruleId: string }>;
}) {
  const { wid, ruleId } = await params;
  const ws = db.workspace(wid);
  const m = ws ? db.monitor(wid, ruleId) : undefined;

  if (!ws || !m) {
    return (
      <Content>
        <EmptyState
          title="Monitor not found"
          body="That rule does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/monitors`}>Back to monitors</LinkButton>}
        />
      </Content>
    );
  }

  const history = [
    { at: m.lastTriggered, state: 'triggered', detail: 'Divergence 23.4% over the 7-day mean. Scout woken.' },
    { at: '2026-11-07T04:00:00.000Z', state: 'suppressed', detail: 'Divergence 20.6%, inside the material-change threshold.' },
    { at: '2026-11-06T04:00:00.000Z', state: 'evaluated', detail: 'No breach.' },
    { at: '2026-11-05T04:00:00.000Z', state: 'skipped', detail: 'Window contained provisional rows. Deferred until finalized.' },
  ].filter((h) => h.at);

  return (
    <>
      <PageHeader
        title={m.name}
        description={m.condition}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Monitors', href: `/w/${wid}/monitors` },
          { label: m.name },
        ]}
        context={
          <>
            <Badge tone={m.enabled ? 'ok' : ''}>{m.enabled ? 'Enabled' : 'Disabled'}</Badge>
            {m.replayOnly && <Badge tone="warn">Replay</Badge>}
            <DataModeIndicator mode={m.replayOnly ? 'replay' : 'frozen'} origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <Button disabled disabledReason="Toggling a rule needs the authorized API.">
            {m.enabled ? 'Disable' : 'Enable'}
          </Button>
        }
      />
      <Content>
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Rule">
            <KeyValues
              rows={[
                { k: 'Condition', v: m.condition },
                { k: 'Window', v: <span className="mono">{m.windowHours} hours</span> },
                { k: 'Evaluates on', v: 'Finalized observations only' },
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
                { k: 'On breach', v: 'Acquire a deduplication lease, wake the scoped agent once, attach a report' },
                { k: 'Budget per wake', v: <span className="mono">$0.80</span> },
              ]}
            />
          </Card>

          <Card title="Bounds">
            <Notice tone="info" title="Why this cannot run away">
              A breach takes a deduplication lease before it wakes anything, so two evaluations of
              the same window cannot both pay for an agent. The agent it wakes cannot schedule
              another evaluation, which is what stops a rule becoming a loop.
            </Notice>
            <KeyValues
              rows={[
                { k: 'Triggers', v: <span className="mono">{m.triggerCount}</span> },
                { k: 'Suppressed as immaterial', v: <span className="mono">{m.suppressed}</span> },
                { k: 'Self-rescheduling', v: 'Not permitted' },
                { k: 'Catch-up on re-enable', v: 'None. Resumes from the current watermark.' },
              ]}
            />
          </Card>
        </div>

        <Card title="Evaluation history">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>At (UTC)</th>
                  <th>Outcome</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.at}>
                    <td className="mono">{formatUtc(h.at)}</td>
                    <td>
                      <Badge
                        tone={h.state === 'triggered' ? 'warn' : h.state === 'skipped' ? 'info' : ''}
                      >
                        {h.state}
                      </Badge>
                    </td>
                    <td className="small">{h.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim">
            A skipped evaluation is recorded, not hidden. A rule that keeps deferring because its
            window never finalizes is a fact worth seeing.
          </p>
        </Card>
      </Content>
    </>
  );
}

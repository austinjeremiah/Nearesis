import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, RunStatus } from '@/components/nx/evidence';
import { BudgetMeter, Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc } from '@/lib/format';

/**
 * Spec 5.15 — run detail.
 *
 * The activity stream shows tool name, metric and result id. It does not show
 * the model's reasoning, because that is not evidence and presenting it beside
 * real results would imply it is.
 */
export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ wid: string; runId: string }>;
}) {
  const { wid, runId } = await params;
  const ws = db.workspace(wid);
  const r = ws ? db.run(wid, runId) : undefined;

  if (!ws || !r) {
    return (
      <Content>
        <EmptyState
          title="Run not found"
          body="That run does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/agents`}>Back to runs</LinkButton>}
        />
      </Content>
    );
  }

  return (
    <>
      <PageHeader
        title="Run"
        description={r.question}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Agents and runs', href: `/w/${wid}/agents` },
          { label: r.id },
        ]}
        context={
          <>
            <RunStatus state={r.state} />
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          r.state === 'running' ? (
            <Button variant="danger" disabled disabledReason="Cancelling a run needs the authorized API.">
              Cancel run
            </Button>
          ) : undefined
        }
      />
      <Content>
        <div className="grid c3">
          <Card title="Cost ledger">
            <BudgetMeter spentUsd={r.spentUsd} budgetUsd={r.budgetUsd} label="Run budget" />
            <KeyValues
              rows={r.tasks.map((t) => ({ k: t.role, v: <span className="mono">{formatUsd(t.costUsd)}</span> }))}
            />
            <p className="tiny dim">Recorded, not estimated.</p>
          </Card>
          <Card title="Timing">
            <KeyValues
              rows={[
                { k: 'Started', v: <span className="mono">{formatUtc(r.startedAt)}</span> },
                { k: 'Ended', v: <span className="mono">{formatUtc(r.endedAt)}</span> },
                { k: 'Tasks', v: <span className="mono">{r.tasks.length}</span> },
              ]}
            />
          </Card>
          <Card title="Inputs">
            <KeyValues
              rows={[
                { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
                { k: 'Semantic version', v: <span className="mono">{db.SEMANTIC_VERSION}</span> },
                { k: 'Branch', v: <span className="mono">{ws.branch}</span> },
              ]}
            />
          </Card>
        </div>

        <Card title="Task trace" subtitle="Tool calls and artifacts. No chain-of-thought.">
          <ol className="col gap4">
            {r.tasks.map((t) => (
              <li key={t.id} className="col gap2" style={{ borderLeft: '2px solid var(--line-strong)', paddingLeft: 14 }}>
                <div className="row gap2 wrap">
                  <Badge outline>{t.role}</Badge>
                  <span className="small strong grow">{t.label}</span>
                  <RunStatus state={t.state} />
                  <span className="tiny mono dim">{formatUsd(t.costUsd)}</span>
                </div>
                <div className="col gap1">
                  {t.toolCalls.map((c, i) => (
                    <div key={i} className="row gap3 wrap tiny">
                      <span className="mono" style={{ minWidth: 170 }}>
                        {c.tool}
                      </span>
                      <span className="dim grow">{c.detail}</span>
                      {c.resultId && <span className="mono dim">{c.resultId}</span>}
                    </div>
                  ))}
                </div>
                {t.artifacts.length > 0 && (
                  <div className="row gap2 wrap">
                    <span className="label">Artifacts</span>
                    {t.artifacts.map((a) => (
                      <Badge key={a} outline>
                        {a}
                      </Badge>
                    ))}
                  </div>
                )}
                <span className="tiny dim mono">
                  {formatUtc(t.startedAt)} to {formatUtc(t.endedAt)}
                </span>
              </li>
            ))}
          </ol>
        </Card>

        <Notice tone="info" title="Why the reasoning is not shown">
          A model&apos;s intermediate text is not an observation and not a citation. What is shown
          here is what the run actually did: which tool, against which measure, producing which
          result id, at what cost. Each of those is checkable.
        </Notice>

        <div className="row gap2">
          <LinkButton href={`/w/${wid}/canvas`}>Open result panels</LinkButton>
          <LinkButton href={`/w/${wid}/evidence`}>Open evidence</LinkButton>
          <Link className="link small" href={`/w/${wid}/timeline`}>
            See this in the timeline
          </Link>
        </div>
      </Content>
    </>
  );
}

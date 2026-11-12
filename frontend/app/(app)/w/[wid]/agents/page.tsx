import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, RunStatus } from '@/components/nx/evidence';
import { BudgetMeter, Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatUsd, formatUtc } from '@/lib/format';

/**
 * Spec 5.14 — agent directory and run activity.
 *
 * Each agent is shown as a capability grant rather than a personality: what it
 * may read, what it may write, what it costs and what it is forbidden from
 * doing. There is no avatar, no status orb and no simulated inner monologue.
 */
const ROLES = [
  { role: 'director', does: 'Decomposes a question into certified queries and a plan', reads: 'Metric catalog', writes: 'Plan drafts', cap: 1.0 },
  { role: 'scout', does: 'Checks source coverage and finds gaps', reads: 'Source health, certified measures', writes: 'Coverage reports', cap: 0.8 },
  { role: 'quant', does: 'Runs forecast models and paired error tests', reads: 'Certified measures in scope', writes: 'Experiments, results', cap: 4.0 },
  { role: 'skeptic', does: 'Proposes alternatives and collects counterevidence', reads: 'Same frozen vintage as the quant', writes: 'Findings, counterevidence', cap: 1.5 },
  { role: 'composer', does: 'Lays out panels for human review', reads: 'Existing panels', writes: 'Canvas patches, never applied directly', cap: 0.4 },
  { role: 'auditor', does: 'Scores results against the pre-registered protocol', reads: 'Experiments, registration hashes', writes: 'Verdicts', cap: 0.6 },
];

export default async function AgentsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const runs = db.runs(wid);

  return (
    <>
      <PageHeader
        title="Agents and runs"
        description="Every agent runs inside a capability grant, with a budget and an audit trail."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Agents and runs' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
      />
      <Content>
        <Notice tone="info" title="What no agent here can do">
          Create a peer agent, widen its own scope, raise a budget, publish under your name, or
          write to any chain. Each of those is an approval bound to the exact action, and the
          approval is void the moment a parameter changes.
        </Notice>

        <section className="col gap3">
          <h2 className="label">Roster</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Responsibility</th>
                  <th>Read scope</th>
                  <th>Write scope</th>
                  <th className="n">Cap per run</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r.role}>
                    <td>
                      <Badge outline>{r.role}</Badge>
                    </td>
                    <td className="small">{r.does}</td>
                    <td className="small dim">{r.reads}</td>
                    <td className="small dim">{r.writes}</td>
                    <td className="n mono">{formatUsd(r.cap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="col gap3">
          <h2 className="label">Runs</h2>
          {runs.length === 0 ? (
            <EmptyState title="No runs yet" body="Approve a plan on the Investigate page to start one." />
          ) : (
            <div className="col gap4">
              {runs.map((r) => (
                <Card
                  key={r.id}
                  title={<Link href={`/w/${wid}/runs/${r.id}`}>{r.question}</Link>}
                  subtitle={`${r.tasks.length} task${r.tasks.length === 1 ? '' : 's'}`}
                  actions={<RunStatus state={r.state} />}
                  footer={
                    <>
                      <span className="tiny dim mono">{formatUtc(r.startedAt)}</span>
                      <div className="grow" />
                      <Link className="link small" href={`/w/${wid}/runs/${r.id}`}>
                        View run
                      </Link>
                    </>
                  }
                >
                  <div className="row gap4 wrap">
                    <BudgetMeter spentUsd={r.spentUsd} budgetUsd={r.budgetUsd} label="Run budget" />
                    <KeyValues
                      rows={[
                        { k: 'Agents', v: r.tasks.map((t) => t.role).join(', ') },
                        { k: 'Ended', v: <span className="mono">{formatUtc(r.endedAt)}</span> },
                      ]}
                    />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </section>
      </Content>
    </>
  );
}

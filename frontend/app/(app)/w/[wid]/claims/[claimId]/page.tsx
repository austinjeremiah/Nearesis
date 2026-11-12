import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, EvidenceVerdict, StatValidity } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { shortHash } from '@/lib/format';

/**
 * Spec 5.19 — claim detail.
 *
 * A claim is only as good as what would overturn it, so the falsification
 * condition and the counterexample sit beside the estimate rather than in a
 * footnote. Evidence for and against are given equal weight on the page.
 */
export default async function ClaimDetailPage({
  params,
}: {
  params: Promise<{ wid: string; claimId: string }>;
}) {
  const { wid, claimId } = await params;
  const ws = db.workspace(wid);
  const c = ws ? db.claim(wid, claimId) : undefined;

  if (!ws || !c) {
    return (
      <Content>
        <EmptyState
          title="Claim not found"
          body="That claim does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/evidence`}>Back to evidence</LinkButton>}
        />
      </Content>
    );
  }

  const hy = db.hypotheses(wid).find((h) => h.id === c.hypothesisId);
  const experiments = db.experiments(wid).filter((x) => x.hypothesisId === c.hypothesisId);

  return (
    <>
      <PageHeader
        title="Claim"
        description={c.statement}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Evidence graph', href: `/w/${wid}/evidence` },
          { label: c.id },
        ]}
        context={
          <>
            <EvidenceVerdict verdict={c.verdict} strength={c.strength} />
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
        actions={
          <>
            <Button disabled disabledReason="Challenging a claim needs the authorized API.">
              Challenge
            </Button>
            <Button disabled disabledReason="Rerunning evidence needs the authorized API.">
              Rerun evidence
            </Button>
          </>
        }
      />
      <Content>
        {c.disputed && (
          <Notice tone="warn" title="Disputed">
            A reviewer or a skeptic agent has raised counterevidence against this claim. The
            verdict below already accounts for it.
          </Notice>
        )}

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Evidence for">
            <KeyValues
              rows={[
                { k: 'Estimate', v: c.estimate },
                {
                  k: 'Result records',
                  v: c.evidenceResultIds.map((r) => (
                    <div key={r} className="mono small">
                      {r}
                    </div>
                  )),
                },
                { k: 'Hypothesis', v: <Link className="link" href={`/w/${wid}/hypotheses`}>{c.hypothesisId}</Link> },
                {
                  k: 'Registration',
                  v: hy?.registered ? (
                    <span className="mono" title={hy.registrationHash}>
                      {shortHash(hy.registrationHash ?? '')}
                    </span>
                  ) : (
                    <Badge tone="warn">Post-hoc, not preregistered</Badge>
                  ),
                },
                { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
                { k: 'Semantic version', v: <span className="mono">{db.SEMANTIC_VERSION}</span> },
              ]}
            />
          </Card>

          <Card title="Evidence against">
            <p className="small" style={{ color: 'var(--warn)' }}>
              {c.counterexample}
            </p>
            <KeyValues
              rows={[
                { k: 'Falsification condition', v: c.falsification },
                {
                  k: 'What would change the verdict',
                  v: 'A robustness cell that currently holds failing, or the cohort-adjusted result moving outside its interval.',
                },
              ]}
            />
            <Notice tone="info" title="Counterevidence is collected, not waited for">
              A skeptic agent runs on the same frozen vintage and the same budget as the model that
              produced the estimate. It does not get the last word, and neither does the estimate.
            </Notice>
          </Card>
        </div>

        <Card title="Supporting experiments">
          {experiments.length === 0 ? (
            <EmptyState title="No experiments attached" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Experiment</th>
                    <th className="n">Origins</th>
                    <th>Horizon</th>
                    <th>Method</th>
                    <th>Best model</th>
                  </tr>
                </thead>
                <tbody>
                  {experiments.map((x) => {
                    const best = x.models.filter((m) => m.smape !== null).sort((a, b) => a.smape! - b.smape!)[0];
                    return (
                      <tr key={x.id}>
                        <td>
                          <Link className="link" href={`/w/${wid}/experiments/${x.id}`}>
                            {x.name}
                          </Link>
                        </td>
                        <td className="n mono">{x.origins}</td>
                        <td className="mono">{x.horizon}</td>
                        <td>
                          <StatValidity validated={x.methodValidated} />
                        </td>
                        <td>
                          {best && x.methodValidated ? (
                            <span className="small">{best.label.split(' · ')[0]}</span>
                          ) : (
                            <span className="unavailable" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Verdict policy" subtitle="Why this verdict and not another.">
          <KeyValues
            rows={[
              { k: 'Supported', v: 'The pre-registered test was met on the locked evaluation.' },
              { k: 'Mixed', v: 'Results differ across specifications or segments. This is where the current verdict sits when robustness cells disagree.' },
              { k: 'Unsupported', v: 'The test was run to standard and not met. A valid, publishable result.' },
              { k: 'Insufficient data', v: 'Not enough observations to decide. Not the same as unsupported.' },
            ]}
          />
        </Card>
      </Content>
    </>
  );
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Content, PageHeader } from '@/components/nx/shell';
import { Badge, DataModeIndicator, ReasonCodeList, RunStatus, StatValidity } from '@/components/nx/evidence';
import { Button, Card, EmptyState, KeyValues, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatMeasure, formatUtc } from '@/lib/format';

/**
 * Spec 5.13 — Experiment Lab.
 *
 * The distinction the spec cares most about is visible in the list: an observed
 * model difference and a calibrated statistical result look different. x3 ran
 * with fewer origins than the protocol pre-declared, so it reports as
 * descriptive only rather than quietly joining the others as a pass.
 */
export default async function ExperimentsPage({ params }: { params: Promise<{ wid: string }> }) {
  const { wid } = await params;
  const ws = db.workspace(wid);
  if (!ws) notFound();
  const rows = db.experiments(wid);

  return (
    <>
      <PageHeader
        title="Experiments"
        description="Rolling-origin evaluation against a pre-registered protocol."
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Experiments' },
        ]}
        context={<DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />}
        actions={
          <Button disabled disabledReason="Running an experiment needs the authorized API.">
            Run experiment
          </Button>
        }
      />
      <Content>
        <Notice tone="info" title="Significance is not causality, and a difference is not significance">
          A lower error here means one model predicted better on this sample. It does not establish
          that Intents volume causes activity, and where the method is not calibrated for the data
          shape the result is marked descriptive only.
        </Notice>

        {rows.length === 0 ? (
          <EmptyState title="No experiments yet" body="Register a hypothesis, then run one against it." />
        ) : (
          <div className="col gap4">
            {rows.map((x) => {
              const best = x.models.filter((m) => m.smape !== null).sort((a, b) => a.smape! - b.smape!)[0];
              return (
                <Card
                  key={x.id}
                  title={<Link href={`/w/${wid}/experiments/${x.id}`}>{x.name}</Link>}
                  subtitle={`${x.origins} forecast origins · ${x.horizon} horizon · ${x.loss}`}
                  actions={
                    <>
                      <StatValidity validated={x.methodValidated} />
                      <RunStatus state={x.state} />
                    </>
                  }
                  footer={
                    <>
                      <span className="tiny dim mono">Started {formatUtc(x.startedAt)}</span>
                      <div className="grow" />
                      <ReasonCodeList codes={x.reasonCodes} />
                    </>
                  }
                >
                  {x.models.length === 0 ? (
                    <p className="small muted">
                      Descriptive study. No model comparison, so no error table.
                    </p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th className="n">MAE</th>
                            <th className="n">sMAPE</th>
                            <th className="n">Bias</th>
                          </tr>
                        </thead>
                        <tbody>
                          {x.models.map((m) => (
                            <tr key={m.id}>
                              <td>
                                <span className="row gap2">
                                  {m.label}
                                  {best && m.id === best.id && x.methodValidated && (
                                    <Badge tone="ok">Best</Badge>
                                  )}
                                </span>
                              </td>
                              <td className="n">
                                {m.mae === null ? <span className="unavailable" /> : <span className="mono">{formatMeasure(m.mae)}</span>}
                              </td>
                              <td className="n">
                                {m.smape === null ? <span className="unavailable" /> : <span className="mono">{m.smape.toFixed(3)}</span>}
                              </td>
                              <td className="n">
                                {m.bias === null ? <span className="unavailable" /> : <span className="mono">{m.bias.toFixed(3)}</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {!x.methodValidated && (
                    <Notice tone="warn" title="Observed difference, significance not established">
                      This ran with {x.origins} origins against a pre-declared minimum of 15. The
                      numbers are reported because hiding them would be worse, but they do not
                      settle the hypothesis.
                    </Notice>
                  )}

                  <KeyValues
                    rows={[
                      { k: 'Hypothesis', v: <Link className="link" href={`/w/${wid}/hypotheses`}>{x.hypothesisId}</Link> },
                      { k: 'Loss function', v: x.loss },
                      { k: 'Multiple comparisons', v: 'Benjamini-Hochberg FDR across the pre-specified lag family' },
                      { k: 'Validation', v: 'Expanding rolling origin with a temporally separated lockbox' },
                    ]}
                  />
                </Card>
              );
            })}
          </div>
        )}
      </Content>
    </>
  );
}

'use client';

import { use, useCallback } from 'react';
import Link from 'next/link';
import { Content, PageHeader } from '@/components/nx/shell';
import { Chart, baseOption, seriesPalette, type ChartTheme } from '@/components/nx/chart';
import { Badge, DataModeIndicator, ReasonCodeList, RunStatus, StatValidity } from '@/components/nx/evidence';
import { Card, EmptyState, KeyValues, LinkButton, Notice } from '@/components/nx/ui';
import * as db from '@/lib/data/client';
import { formatMeasure, formatUtc } from '@/lib/format';

/**
 * Spec 5.13 — experiment detail.
 *
 * Model comparison, robustness matrix and forecast intervals. The robustness
 * matrix is the honest part: it shows the cells where the result holds and the
 * cells where it does not, including the ones that could not be computed.
 */
export default function ExperimentDetailPage({
  params,
}: {
  params: Promise<{ wid: string; experimentId: string }>;
}) {
  const { wid, experimentId } = use(params);
  const ws = db.workspace(wid);
  const x = db.experiment(wid, experimentId);

  const errorChart = useCallback(
    (t: ChartTheme) => {
      const base = baseOption(t);
      const models = x?.models.filter((m) => m.smape !== null) ?? [];
      return {
        ...base,
        grid: { left: 56, right: 16, top: 16, bottom: 40 },
        xAxis: {
          type: 'category',
          data: models.map((m) => m.label.split(' · ')[0]),
          axisLine: { lineStyle: { color: t.lineStrong } },
          axisTick: { show: false },
          axisLabel: { color: t.text3, fontFamily: t.mono, fontSize: 10 },
        },
        yAxis: { ...(base.yAxis as object), name: 'sMAPE', nameTextStyle: { color: t.text3, fontSize: 10 } },
        tooltip: { trigger: 'axis', backgroundColor: '#2a2a2a', borderWidth: 0, textStyle: { color: '#f1efe2', fontSize: 12 } },
        series: [
          {
            type: 'bar',
            barWidth: '46%',
            data: models.map((m, i) => ({
              value: m.smape,
              itemStyle: { color: i === 1 ? t.accent : t.text3 },
            })),
          },
        ],
      };
    },
    [x],
  );

  if (!ws || !x) {
    return (
      <Content>
        <EmptyState
          title="Experiment not found"
          body="That experiment does not exist, or you do not have access to it."
          action={<LinkButton href={`/w/${wid}/experiments`}>Back to experiments</LinkButton>}
        />
      </Content>
    );
  }

  const ROBUSTNESS = [
    { cell: 'Full sample, 7-day horizon', result: 'Improves', tone: 'ok' as const },
    { cell: 'Top 5% volume cohort removed', result: 'Marginal', tone: 'warn' as const },
    { cell: 'Stablecoin routes only', result: 'Improves', tone: 'ok' as const },
    { cell: 'Non-stablecoin routes only', result: 'No difference', tone: '' as const },
    { cell: 'Before 2026-10-27', result: 'Improves', tone: 'ok' as const },
    { cell: 'After 2026-10-27', result: 'Not observable', tone: 'info' as const },
    { cell: '14-day horizon', result: 'Insufficient origins', tone: 'info' as const },
    { cell: 'Top daily spikes excluded', result: 'Improves', tone: 'ok' as const },
  ];

  return (
    <>
      <PageHeader
        title={x.name}
        description={`${x.origins} forecast origins at a ${x.horizon} horizon, scored with ${x.loss}.`}
        crumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: ws.name, href: `/w/${wid}/overview` },
          { label: 'Experiments', href: `/w/${wid}/experiments` },
          { label: x.name },
        ]}
        context={
          <>
            <StatValidity validated={x.methodValidated} />
            <RunStatus state={x.state} />
            <DataModeIndicator mode="frozen" origin="fixture" watermark={db.SNAPSHOT_AS_OF} />
          </>
        }
      />
      <Content>
        {!x.methodValidated && (
          <Notice tone="warn" title="Observed model difference, statistical significance not established">
            This experiment ran with {x.origins} forecast origins. The pre-registered protocol
            declared a minimum of 15. The results below are descriptive and must not be cited as a
            test outcome.
          </Notice>
        )}

        <div className="grid c2" style={{ alignItems: 'start' }}>
          <Card title="Forecast error by model" subtitle="Lower is better. Same data vintage for every model.">
            {x.models.length === 0 ? (
              <EmptyState title="Descriptive study" body="No model comparison was run." />
            ) : (
              <Chart option={errorChart} height={240} ariaLabel="Forecast error by model" />
            )}
          </Card>

          <Card title="Protocol">
            <KeyValues
              rows={[
                { k: 'Hypothesis', v: <Link className="link" href={`/w/${wid}/hypotheses`}>{x.hypothesisId}</Link> },
                { k: 'Origins', v: <span className="mono">{x.origins}</span> },
                { k: 'Horizon', v: <span className="mono">{x.horizon}</span> },
                { k: 'Loss', v: x.loss },
                { k: 'Validation', v: 'Expanding rolling origin, temporally separated lockbox' },
                { k: 'Multiple comparisons', v: 'Benjamini-Hochberg across the pre-specified lag family' },
                { k: 'Paired test', v: 'Diebold-Mariano with HAC errors, where the sample permits' },
                { k: 'Started', v: <span className="mono">{formatUtc(x.startedAt)}</span> },
                { k: 'Snapshot', v: <span className="mono">{db.SNAPSHOT_ID}</span> },
              ]}
            />
            <ReasonCodeList codes={x.reasonCodes} />
          </Card>
        </div>

        <Card title="Model comparison">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Specification</th>
                  <th className="n">MAE</th>
                  <th className="n">sMAPE</th>
                  <th className="n">Forecast bias</th>
                </tr>
              </thead>
              <tbody>
                {x.models.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.label.split(' · ')[0]}</td>
                    <td>{m.label.split(' · ')[1]}</td>
                    <td className="n">{m.mae === null ? <span className="unavailable" /> : <span className="mono">{formatMeasure(m.mae)}</span>}</td>
                    <td className="n">{m.smape === null ? <span className="unavailable" /> : <span className="mono">{m.smape.toFixed(3)}</span>}</td>
                    <td className="n">{m.bias === null ? <span className="unavailable" /> : <span className="mono">{m.bias.toFixed(3)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="tiny dim">
            A row with an em dash did not produce a result. It is kept so the reader can see which
            specification failed, rather than only the ones that worked.
          </p>
        </Card>

        <Card title="Robustness matrix" subtitle="Every pre-declared cell, including the ones that did not hold.">
          <div className="grid c2">
            {ROBUSTNESS.map((r) => (
              <div
                key={r.cell}
                className="row between"
                style={{ borderBottom: '1px dashed var(--line)', padding: '8px 0' }}
              >
                <span className="small">{r.cell}</span>
                <Badge tone={r.tone}>{r.result}</Badge>
              </div>
            ))}
          </div>
          <Notice tone="info" title="Null and untestable cells are shown as such">
            A cell that could not be computed is reported as not observable or insufficient, not
            quietly dropped from the matrix.
          </Notice>
        </Card>
      </Content>
    </>
  );
}

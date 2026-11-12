'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionBar } from '@/components/nx/section';
import { Badge } from '@/components/nx/evidence';
import { BudgetMeter, Button, Card, Field, Input, KeyValues, Notice } from '@/components/nx/ui';
import { DataTable } from '@/components/nx/table';
import { StateBanner } from '@/components/nx/states';
import { formatUsd, formatUtc } from '@/lib/format';
import { cost, type CostForecast } from '@/lib/ws6/api';
import { ActionError, Slot, useAction } from '@/components/ws6/common';

const k = (wid: string, ...p: string[]) => ['ws', wid, 'cost', ...p];
const usd = (v: number | null) => (v === null ? <span className="dim" data-unknown="true">price unknown</span> : <span className="mono">{formatUsd(v, 4)}</span>);

function Forecast({ f }: { f: CostForecast }) {
  return (
    <div className="col gap2" data-testid="forecast">
      <div className="row gap2">
        <Badge tone="info">Projection, not a measurement</Badge>
        <Badge outline>confidence: {f.confidence.replace(/_/g, ' ')}</Badge>
      </div>
      {f.projectedPeriodUsd === null ? (
        <p className="small" data-testid="forecast-none">No projection is made yet: there is not enough settled spend to extrapolate from.</p>
      ) : (
        <KeyValues
          rows={[
            { k: 'Projected period spend', v: <span className="mono">{formatUsd(f.projectedPeriodUsd, 4)}</span> },
            { k: 'Projected over cap', v: f.projectedOverCap === null ? <span className="dim">no cap set</span> : f.projectedOverCap ? <Badge tone="bad">yes</Badge> : <Badge tone="ok">no</Badge> },
            { k: 'Projected exhaustion', v: f.projectedExhaustionAt ? <span className="mono">{formatUtc(f.projectedExhaustionAt)}</span> : <span className="dim">none projected</span> },
          ]}
        />
      )}
      <div className="label">Assumptions ({f.method.replace(/_/g, ' ')})</div>
      <ul className="small" data-testid="forecast-assumptions">
        {f.assumptions.map((a, i) => (
          <li key={i}>{a}</li>
        ))}
      </ul>
    </div>
  );
}

export default function CostView({ wid }: { wid: string }) {
  const burn = useQuery({ queryKey: k(wid, 'burn'), queryFn: () => cost.burn(wid) });
  const ledger = useQuery({ queryKey: k(wid, 'ledger'), queryFn: () => cost.ledger(wid) });
  const recon = useQuery({ queryKey: k(wid, 'reconciliation'), queryFn: () => cost.reconciliation(wid) });
  const global = useQuery({ queryKey: ['cost', 'global'], queryFn: cost.global, retry: false });
  const [cap, setCap] = useState('');
  const setPolicy = useAction(() => cost.setPolicy(wid, { capUsd: Number(cap) }), { invalidate: [k(wid, 'burn')], onDone: () => setCap('') });
  const resume = useAction(() => cost.resume(wid), { invalidate: [k(wid, 'burn')] });

  return (
    <>
      <section>
        <SectionBar title="Global ceiling" number="001" />
        <Card title="Model-spend ceiling across all workspaces">
          <Slot q={global}>
            {(g) => (
              <div className="col gap3" data-testid="global-cost" data-state={g.state}>
                {g.state !== 'ok' && <StateBanner state={g.state === 'exhausted' ? 'budget_exhausted' : 'partial'} detail={`Global state: ${g.state}.`} />}
                <BudgetMeter spentUsd={g.committedUsd} budgetUsd={g.ceilingUsd} label="Committed of ceiling" />
                <KeyValues
                  rows={[
                    { k: 'Settled', v: <span className="mono">{formatUsd(g.settledUsd, 4)}</span> },
                    { k: 'Reserved', v: <span className="mono">{formatUsd(g.reservedUsd, 4)}</span> },
                    { k: 'Recorded outside the ledger', v: <span className="mono">{formatUsd(g.externalUsd, 4)}</span> },
                    { k: 'Remaining', v: <span className="mono">{formatUsd(g.remainingUsd, 4)}</span> },
                    { k: 'Unknown-price entries', v: <span className="mono">{g.unknownPriceEntries}</span> },
                  ]}
                />
                <div className="row gap2">
                  {g.thresholds.map((t) => (
                    <Badge key={t.fraction} tone={t.reached ? 'warn' : ''} outline={!t.reached}>
                      {Math.round(t.fraction * 100)}% ({formatUsd(t.usd)}){t.reached ? ' reached' : ''}
                    </Badge>
                  ))}
                </div>
                {g.forecast && <Forecast f={g.forecast} />}
              </div>
            )}
          </Slot>
        </Card>
      </section>

      <section>
        <SectionBar title="This workspace" number="002" />
        <div className="grid c2">
          <Card title="Burn this period">
            <Slot q={burn}>
              {(b) => (
                <div className="col gap3" data-testid="burn" data-hard-stopped={String(b.hardStopped)}>
                  {b.hardStopped && <StateBanner state="budget_exhausted" detail={b.hardStopReason ?? undefined} />}
                  {b.capUsd !== null ? (
                    <BudgetMeter spentUsd={b.spentUsd} budgetUsd={b.capUsd} label="This period" />
                  ) : (
                    <p className="small" data-testid="no-cap">No cap is set for this workspace. Spent {formatUsd(b.spentUsd, 4)} this period.</p>
                  )}
                  <KeyValues
                    rows={[
                      { k: 'Period', v: <span className="mono">{formatUtc(b.period.start, false)} to {formatUtc(b.period.end, false)}</span> },
                      { k: 'Spent', v: <span className="mono">{formatUsd(b.spentUsd, 4)}</span> },
                      { k: 'Reserved', v: <span className="mono">{formatUsd(b.reservedUsd, 4)}</span> },
                      { k: 'Rate, last hour', v: <span className="mono">{formatUsd(b.burnRateUsdPerHour.last1h, 4)}/h</span> },
                      { k: 'Rate, last 24 h', v: <span className="mono">{formatUsd(b.burnRateUsdPerHour.last24h, 4)}/h</span> },
                      { k: 'Spends blocked', v: <span className="mono">{b.blocks.total}</span> },
                      {
                        k: 'Unknown prices',
                        v: b.priceUnknown.entries ? <Badge tone="warn">{b.priceUnknown.entries} entries have no price</Badge> : <span className="dim">none</span>,
                      },
                      { k: 'As of', v: <span className="mono">{formatUtc(b.asOf)}</span> },
                    ]}
                  />
                  <Forecast f={b.forecast} />
                </div>
              )}
            </Slot>
          </Card>
          <Card title="Limits">
            <div className="col gap3">
              <Field label="Monthly cap (USD)" help="Sets the workspace cap. Owner or admin only.">
                <Input type="number" min={0} step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} data-testid="cap-input" />
              </Field>
              <div className="row gap2">
                <Button variant="primary" onClick={() => void setPolicy.run()} pending={setPolicy.pending} disabled={cap === '' || Number(cap) < 0} disabledReason="Enter a non-negative amount" data-testid="cap-save">
                  Save cap
                </Button>
                <Button onClick={() => void resume.run()} pending={resume.pending} disabled={!burn.data?.hardStopped} disabledReason="The workspace is not hard-stopped" data-testid="cost-resume">
                  Resume after hard stop
                </Button>
              </div>
              <ActionError error={setPolicy.error} />
              <ActionError error={resume.error} />
              <Slot q={burn}>
                {(b) => (
                  <>
                    <div className="label">Per-resource usage</div>
                    <DataTable
                      caption="Per-resource usage"
                      rows={b.dimensions}
                      rowKey={(d) => d.dimension}
                      columns={[
                        { key: 'd', header: 'Resource', render: (d) => <span className="mono small">{d.dimension}</span> },
                        { key: 'q', header: 'Quantity', numeric: true, render: (d) => (d.quantity === null ? <span className="dim">not metered</span> : `${d.quantity} ${d.unit}`) },
                        { key: 'u', header: 'USD', numeric: true, render: (d) => usd(d.usd) },
                        { key: 'l', header: 'Limit', numeric: true, render: (d) => (d.limit === null ? <span className="dim">none</span> : d.limit) },
                      ]}
                    />
                  </>
                )}
              </Slot>
            </div>
          </Card>
        </div>
      </section>

      <section>
        <SectionBar title="Ledger" number="003" />
        <Card title="Metering entries">
          <Slot q={ledger}>
            {(l) => (
              <div className="col gap3">
                <DataTable
                  caption="Ledger"
                  rows={l.entries}
                  rowKey={(e) => e.key}
                  empty={{ title: 'No metered spend yet', body: 'Paid work records an entry here before and after it runs.' }}
                  columns={[
                    { key: 'at', header: 'When', render: (e) => <span className="mono small">{formatUtc(e.createdAt)}</span> },
                    { key: 'd', header: 'Resource', render: (e) => <span className="mono small">{e.dimension}</span> },
                    { key: 's', header: 'State', render: (e) => e.state },
                    { key: 'q', header: 'Quantity', numeric: true, render: (e) => e.quantity },
                    { key: 'u', header: 'USD', numeric: true, render: (e) => usd(e.usd) },
                    { key: 'op', header: 'Operation', render: (e) => e.paidOp ?? <span className="dim">none</span> },
                  ]}
                />
                {l.blocks.length > 0 && (
                  <>
                    <div className="label">Blocked spends</div>
                    <DataTable
                      caption="Blocked spends"
                      rows={l.blocks}
                      rowKey={(b) => `${b.key}-${b.createdAt}`}
                      columns={[
                        { key: 'at', header: 'When', render: (b) => <span className="mono small">{formatUtc(b.createdAt)}</span> },
                        { key: 'd', header: 'Resource', render: (b) => b.dimension },
                        { key: 'r', header: 'Reason', render: (b) => <Badge tone="warn">{b.reason.replace(/_/g, ' ')}</Badge> },
                        { key: 'u', header: 'Requested', numeric: true, render: (b) => usd(b.requestedUsd) },
                      ]}
                    />
                  </>
                )}
              </div>
            )}
          </Slot>
        </Card>
      </section>

      <section>
        <SectionBar title="Reconciliation" number="004" />
        <Card title="Reservations against actual charges">
          <Slot q={recon}>
            {(r) => (
              <>
                <DataTable
                  caption="Reconciliation"
                  rows={r.dimensions}
                  rowKey={(d) => d.dimension}
                  columns={[
                    { key: 'd', header: 'Resource', render: (d) => <span className="mono small">{d.dimension}</span> },
                    { key: 'r', header: 'Reserved', numeric: true, render: (d) => `${d.reserved.entries} / ${formatUsd(d.reserved.usd, 4)}` },
                    { key: 's', header: 'Settled', numeric: true, render: (d) => `${d.settled.entries} / ${formatUsd(d.settled.usd, 4)}` },
                    { key: 'x', header: 'Released', numeric: true, render: (d) => d.released.entries },
                    { key: 'p', header: 'Price unknown', numeric: true, render: (d) => (d.priceUnknown.entries ? <Badge tone="warn">{d.priceUnknown.entries}</Badge> : 0) },
                    {
                      key: 'v',
                      header: 'Estimate vs actual',
                      numeric: true,
                      render: (d) => (d.estimateVsActual.comparedEntries ? `${formatUsd(d.estimateVsActual.varianceUsd, 4)} over ${d.estimateVsActual.comparedEntries}` : <span className="dim">nothing to compare</span>),
                    },
                  ]}
                />
                <Notice tone="info" title="Reading this table">Entries with an unknown price are counted apart and are never summed as zero.</Notice>
              </>
            )}
          </Slot>
        </Card>
      </section>
    </>
  );
}

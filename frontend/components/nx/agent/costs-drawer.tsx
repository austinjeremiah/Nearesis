'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Drawer } from '@/components/nx/overlays';
import { Skeleton } from '@/components/nx/ui';
import { ApiErrorState } from '@/components/nx/states';
import { agentApi, agentKeys } from '@/lib/agent/api';
import { creditsApi } from '@/lib/near/api';
import { costDetailText, formatEntry, formatUsdString, nearblocksTx } from '@/lib/agent/tasks';
import { formatUsdFull } from '@/lib/credits/usd';
import { formatUtc } from '@/lib/format';

/** Every model and on-chain cost the agent incurred for this thread in USD (NEAR and the rate as detail), plus the credits balance. */
export default function CostsDrawer({ open, onOpenChange, threadId }: { open: boolean; onOpenChange: (v: boolean) => void; threadId: string | null }) {
  const costs = useQuery({ queryKey: agentKeys.costs(threadId), queryFn: () => agentApi.costs(threadId), enabled: open, refetchInterval: open ? 10_000 : false, retry: false });
  const credits = useQuery({ queryKey: ['agent', 'credits'], queryFn: () => creditsApi.get(), enabled: open, retry: false });
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Costs of this conversation">
      <div className="col gap3" data-testid="costs-drawer">
        <section aria-label="Credits balance">
          <p className="ag-k">Your credits</p>
          {credits.isPending ? (
            <Skeleton rows={1} />
          ) : credits.isError ? (
            <ApiErrorState error={credits.error} onRetry={() => credits.refetch()} />
          ) : (
            <dl className="ag-estimates">
              <div><dt>Available</dt><dd className="mono" data-testid="costs-available">{formatUsdFull(credits.data.availableUsd)}</dd></div>
              <div><dt>Held</dt><dd className="mono">{formatUsdFull(credits.data.heldUsd)}</dd></div>
              <div><dt>Allowance</dt><dd className="mono">{formatUsdFull(credits.data.allowanceUsd)}</dd></div>
            </dl>
          )}
          <p className="small" style={{ margin: '6px 0 0' }}><Link className="link" href="/credits">Review credits</Link></p>
        </section>
        <section aria-label="Totals">
          <p className="ag-k">Totals</p>
          {costs.isPending ? (
            <Skeleton rows={1} />
          ) : costs.isError ? (
            <ApiErrorState error={costs.error} onRetry={() => costs.refetch()} />
          ) : (
            <dl className="ag-estimates" data-testid="costs-totals">
              <div><dt>Model</dt><dd className="mono">{formatUsdString(costs.data.totals.modelUsd)}</dd></div>
              <div><dt>Model calls</dt><dd className="mono">{costs.data.totals.modelCalls ?? 'unknown'}</dd></div>
              <div><dt>On chain</dt><dd className="mono">{formatUsdString(costs.data.totals.onChainUsd)}</dd></div>
              <div><dt>Total</dt><dd className="mono strong" data-testid="costs-total">{formatUsdString(costs.data.totals.totalUsd)}</dd></div>
            </dl>
          )}
        </section>
        {costs.isSuccess && (
          <section aria-label="Every charge">
            <p className="ag-k">Every charge ({costs.data.items.length})</p>
            {costs.data.items.length === 0 ? (
              <p className="small dim">Nothing has been charged in this conversation.</p>
            ) : (
              <div className="table-wrap">
                <table className="table" data-testid="costs-table">
                  <thead>
                    <tr><th>When</th><th>Step</th><th>What</th><th className="n">Amount</th><th>Tx</th></tr>
                  </thead>
                  <tbody>
                    {costs.data.items.map((c) => {
                      const near = costDetailText(c.detail);
                      return (
                        <tr key={c.id}>
                          <td className="tiny mono">{c.at ? formatUtc(c.at) : 'unknown'}</td>
                          <td className="tiny mono">{c.stepIdx === null ? '—' : `${c.stepIdx + 1}`}{c.stepKey ? ` ${c.stepKey}` : ''}</td>
                          <td className="small">{c.label}{near && <span className="tiny dim" style={{ display: 'block' }}>{near}</span>}</td>
                          <td className="n mono small">{formatEntry(c)}</td>
                          <td className="tiny mono">{c.txHash ? <a className="link" href={nearblocksTx(c.txHash)} target="_blank" rel="noreferrer noopener">{c.txHash.slice(0, 8)}</a> : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </Drawer>
  );
}

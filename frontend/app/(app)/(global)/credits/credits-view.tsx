'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { DataTable, type Column } from '@/components/nx/table';
import { ApiErrorState } from '@/components/nx/states';
import { Button, Card, KeyValues, Notice, Skeleton } from '@/components/nx/ui';
import { qk } from '@/lib/api/keys';
import { shellBrowser } from '@/lib/api/shell-browser';
import { formatUtc } from '@/lib/format';
import { creditsApi, creditsKey } from '@/lib/near/api';
import { formatNear } from '@/lib/near/units';
import { txUrl } from '@/lib/near/units';
import { CATEGORY_LABEL, entryNearDetail, type CreditEntry } from '@/lib/credits/model';
import { entryHref, entryTxHash, entryWhat } from '@/lib/credits/entries';
import { openCreditsPopup } from '@/lib/credits/refusal';
import { formatUsdFull, isLow } from '@/lib/credits/usd';

const KIND_TONE: Record<string, 'ok' | 'warn' | 'info' | ''> = { grant: 'ok', hold: 'warn', charge: 'info', release: '' };

const COLUMNS: Column<CreditEntry>[] = [
  { key: 'at', header: 'When', render: (e) => <span className="mono small">{e.createdAt ? formatUtc(e.createdAt) : 'unknown'}</span> },
  { key: 'kind', header: 'Kind', render: (e) => <Badge tone={KIND_TONE[e.kind] ?? ''} outline={!KIND_TONE[e.kind]}>{e.kind}</Badge> },
  { key: 'cat', header: 'Category', render: (e) => <span className="small">{e.category ? (CATEGORY_LABEL[e.category] ?? e.category) : 'unknown'}</span> },
  {
    key: 'amount',
    header: 'Amount (USD)',
    numeric: true,
    render: (e) => <span className="mono" data-testid="entry-amount">{formatUsdFull(e.amountUsd)}</span>,
  },
  {
    key: 'what',
    header: 'What it was for',
    render: (e) => {
      const what = entryWhat(e);
      const href = entryHref(e);
      const near = entryNearDetail(e, (y) => formatNear(y, { round: 'up' }));
      return (
        <span className="small col" style={{ gap: 2 }}>
          <span>
            {href ? <Link className="link" href={href}>{what.text}</Link> : what.text}
            {what.short && <span className="mono dim"> {what.short}</span>}
          </span>
          {(near.near || near.rate) && (
            <span className="tiny dim" data-testid="entry-near">
              {near.near ? `${near.near} NEAR` : null}
              {near.near && near.rate ? ' at ' : null}
              {near.rate ? `$${near.rate} per NEAR${near.rateDate ? ` on ${near.rateDate}` : ''}` : null}
            </span>
          )}
        </span>
      );
    },
  },
  {
    key: 'tx',
    header: 'Transaction',
    render: (e) => {
      const h = entryTxHash(e);
      return h ? (
        <a className="link mono small" href={txUrl(h)} target="_blank" rel="noreferrer" data-testid="entry-tx" title={h}>
          {h.slice(0, 10)}…
        </a>
      ) : (
        <span className="dim small">none</span>
      );
    },
  },
];

export default function CreditsView() {
  const q = useQuery({ queryKey: creditsKey, queryFn: () => creditsApi.get(), refetchInterval: 30_000, retry: false });
  const me = useQuery({ queryKey: qk.me, queryFn: () => shellBrowser.me(), retry: false, staleTime: 60_000 });
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton rows={5} />;
  const c = q.data;
  const low = isLow(c.availableUsd, c.allowanceUsd);
  return (
    <div className="col gap4">
      {!c.known && (
        <Notice tone="warn" title="Credit figures are not available yet">
          The API did not return USD credit figures, so nothing is shown as a number rather than a guess. Reload in a moment.
        </Notice>
      )}
      {c.exhausted === true && (
        <Notice tone="bad" title="You have used your credits">
          <span className="row gap2 wrap" style={{ alignItems: 'center' }}>
            <span>Write to {c.contactEmail} to request more access.</span>
            <Button onClick={() => openCreditsPopup({ allowanceUsd: c.allowanceUsd, availableUsd: c.availableUsd, contactEmail: c.contactEmail })} data-testid="credits-request">
              Request more access
            </Button>
          </span>
        </Notice>
      )}
      <Card
        title="Your credits"
        subtitle="One allowance in USD. It covers AI model calls and OutLayer proofs; proofs and publication anchors are paid on chain by the app's wallet and converted to USD at the NEAR price of the day."
      >
        <div data-testid="credits-balance">
          <KeyValues
            rows={[
              { k: 'Allowance', v: <span className="mono" data-testid="allowance">{formatUsdFull(c.allowanceUsd)}</span> },
              { k: 'Spent', v: <span className="mono" data-testid="spent">{formatUsdFull(c.spentUsd)}</span> },
              { k: 'Held for running proofs', v: <span className="mono" data-testid="held">{formatUsdFull(c.heldUsd)}</span> },
              {
                k: 'Available',
                v: (
                  <span className="mono strong" style={c.exhausted === true ? { color: 'var(--bad)' } : low ? { color: 'var(--warn)' } : undefined} data-testid="available">
                    {formatUsdFull(c.availableUsd)}
                    {c.exhausted === true ? ' (used up)' : low ? ' (low)' : ''}
                  </span>
                ),
              },
              { k: 'One OutLayer proof holds', v: <span className="mono">{formatUsdFull(c.proofEstimateUsd)}</span> },
              { k: 'NEAR price used', v: c.nearUsdRate ? <span className="mono small">${c.nearUsdRate.rate}{c.nearUsdRate.date ? ` on ${c.nearUsdRate.date}` : ''}</span> : <span className="dim">unknown</span> },
              { k: 'Linked NEAR account', v: me.data?.nearAccountId ? <span className="mono small">{me.data.nearAccountId}</span> : <span className="dim">{me.data ? 'none' : 'unknown'}</span> },
            ]}
          />
        </div>
      </Card>
      <Card title="Where it went" subtitle="Spent so far, by what it paid for.">
        <div data-testid="credits-breakdown">
          <KeyValues
            rows={[
              { k: 'AI model', v: <span className="mono" data-testid="by-model">{formatUsdFull(c.byCategory.modelUsd)}</span> },
              { k: 'OutLayer proofs', v: <span className="mono" data-testid="by-outlayer">{formatUsdFull(c.byCategory.outlayerUsd)}</span> },
              { k: 'Publication anchors', v: <span className="mono" data-testid="by-anchor">{formatUsdFull(c.byCategory.anchorUsd)}</span> },
            ]}
          />
        </div>
      </Card>
      <Card title="History" subtitle="Newest 100 changes. A proof first holds credits, then charges what OutLayer and gas actually cost and releases the rest.">
        <DataTable
          caption="Credit history"
          columns={COLUMNS}
          rows={c.entries}
          rowKey={(e) => e.id}
          empty={{ title: 'No credit activity yet', body: 'Model calls and OutLayer proofs show up here as they are charged.' }}
        />
      </Card>
    </div>
  );
}

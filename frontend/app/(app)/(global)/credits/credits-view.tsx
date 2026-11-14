'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { DataTable, type Column } from '@/components/nx/table';
import { ApiErrorState } from '@/components/nx/states';
import { LinkNearWallet } from '@/components/nx/near-link';
import { NearErrorNotice } from '@/components/nx/near-error';
import { Button, Card, Field, Input, KeyValues, Notice, Skeleton } from '@/components/nx/ui';
import { formatUtc } from '@/lib/format';
import { creditsApi, creditsKey, type CreditEntry, type Credits } from '@/lib/near/api';
import { formatNear, nearToYocto, txUrl } from '@/lib/near/units';
import { sendTransfer } from '@/lib/near/wallet';

const KIND_TONE: Record<string, 'ok' | 'warn' | 'info' | ''> = { topup: 'ok', hold: 'warn', charge: 'info', release: '' };

function txHashOfEntry(e: CreditEntry): string | null {
  const h = e.detail?.txHash;
  return typeof h === 'string' && h ? h : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function AddCredits({ c }: { c: Credits }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('1');
  const [manual, setManual] = useState('');
  const [pending, setPending] = useState<'send' | 'manual' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const yocto = nearToYocto(amount);

  async function credit(hash: string) {
    const next = await creditsApi.topup(hash);
    qc.setQueryData(creditsKey, next);
    setDone(hash);
  }

  async function add() {
    if (!yocto) return;
    setPending('send');
    setError(null);
    setDone(null);
    try {
      const hash = await sendTransfer({ receiverId: c.depositAccount, depositYocto: yocto, expectAccountId: c.accountId });
      await credit(hash);
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
      void qc.invalidateQueries({ queryKey: creditsKey });
    }
  }

  async function addManual() {
    const h = manual.trim();
    if (!h) return;
    setPending('manual');
    setError(null);
    setDone(null);
    try {
      await credit(h);
      setManual('');
    } catch (e) {
      setError(e);
    } finally {
      setPending(null);
    }
  }

  if (!c.accountId) {
    return (
      <Card title="Add credits">
        <div className="col gap2">
          <Notice tone="info" title="Link a NEAR wallet first">
            Credits are bought with a transfer from your own testnet account. Link the account so the API can match the transfer to you.
          </Notice>
          <LinkNearWallet />
        </div>
      </Card>
    );
  }

  return (
    <Card title="Add credits" subtitle={`Transfer testnet NEAR from ${c.accountId} to ${c.depositAccount}.`}>
      <div className="col gap3" data-testid="add-credits">
        <Field label="Amount (NEAR)" help={yocto ? `${yocto} yoctoNEAR` : 'Enter a positive amount, up to 24 decimals.'}>
          <Input id="topup-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" data-testid="topup-amount" />
        </Field>
        <div className="row gap2">
          <Button
            variant="primary"
            pending={pending === 'send'}
            disabled={!yocto}
            disabledReason="Enter a valid amount"
            onClick={() => void add()}
            data-testid="topup-send"
          >
            Add {yocto ? formatNear(yocto) : ''} NEAR in your wallet
          </Button>
        </div>
        <p className="small dim">Your wallet asks you to approve the transfer. Credits appear once the transaction is final on testnet.</p>
        <details>
          <summary className="small">Credit a transfer you already sent</summary>
          <div className="row gap2" style={{ marginTop: 8 }}>
            <Input aria-label="Transaction hash" placeholder="Transaction hash" value={manual} onChange={(e) => setManual(e.target.value)} autoComplete="off" data-testid="topup-hash" />
            <Button pending={pending === 'manual'} disabled={!manual.trim()} disabledReason="Paste a transaction hash" onClick={() => void addManual()}>
              Credit
            </Button>
          </div>
        </details>
        <NearErrorNotice error={error} title="Credits were not added" />
        {done && (
          <Notice tone="ok" title="Credits added">
            Transaction{' '}
            <a className="link mono" href={txUrl(done)} target="_blank" rel="noreferrer">
              {done.slice(0, 12)}…
            </a>{' '}
            was credited.
          </Notice>
        )}
      </div>
    </Card>
  );
}

const COLUMNS: Column<CreditEntry>[] = [
  { key: 'at', header: 'When', render: (e) => <span className="mono small">{formatUtc(e.createdAt)}</span> },
  { key: 'kind', header: 'Kind', render: (e) => <Badge tone={KIND_TONE[e.kind] ?? ''} outline={!KIND_TONE[e.kind]}>{e.kind}</Badge> },
  {
    key: 'amount',
    header: 'Amount (NEAR)',
    numeric: true,
    render: (e) => <span className="mono" title={`${e.amountYocto} yoctoNEAR`}>{formatNear(e.amountYocto)}</span>,
  },
  {
    key: 'ref',
    header: 'Reference',
    render: (e) => {
      const gas = str(e.detail?.tokensBurntYocto);
      const charged = str(e.detail?.chargedYocto);
      return (
        <span className="small">
          {e.refKind ? <span className="mono">{e.refKind}{e.refId ? ` ${e.refId.slice(0, 8)}` : ''}</span> : <span className="dim">none</span>}
          {e.kind === 'charge' && (charged || gas) && (
            <span className="dim"> · OutLayer {formatNear(charged)} + gas {formatNear(gas)}</span>
          )}
        </span>
      );
    },
  },
  {
    key: 'tx',
    header: 'Transaction',
    render: (e) => {
      const h = txHashOfEntry(e);
      return h ? (
        <a className="link mono small" href={txUrl(h)} target="_blank" rel="noreferrer" data-testid="entry-tx">
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
  if (q.isError) return <ApiErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton rows={5} />;
  const c = q.data;
  return (
    <div className="col gap4">
      <Card title="Balance" subtitle={`NEAR ${c.network}. Test funds only.`}>
        <div data-testid="credits-balance">
          <KeyValues
            rows={[
              { k: 'Balance', v: <span className="mono" data-testid="balance">{formatNear(c.balanceYocto)} NEAR</span> },
              { k: 'Held for running proofs', v: <span className="mono" data-testid="held">{formatNear(c.heldYocto)} NEAR</span> },
              { k: 'Available', v: <span className="mono strong" data-testid="available">{formatNear(c.availableYocto)} NEAR</span> },
              { k: 'Linked account', v: c.accountId ? <span className="mono small">{c.accountId}</span> : <span className="dim">none</span> },
              { k: 'Deposit account', v: <span className="mono small">{c.depositAccount}</span> },
              { k: 'One OutLayer proof holds', v: <span className="mono">{formatNear(c.proofEstimateYocto, { round: 'up' })} NEAR</span> },
            ]}
          />
        </div>
      </Card>
      <AddCredits c={c} />
      <Card title="History" subtitle="Newest 50 changes. A proof first holds credits, then charges what OutLayer and gas actually cost and releases the rest.">
        <DataTable
          caption="Credit history"
          columns={COLUMNS}
          rows={c.entries}
          rowKey={(e) => e.id}
          empty={{ title: 'No credit activity yet', body: 'Add credits to pay for OutLayer proofs.' }}
        />
      </Card>
    </div>
  );
}

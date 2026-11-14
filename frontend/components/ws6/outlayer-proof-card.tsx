'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/nx/evidence';
import { ApiErrorState } from '@/components/nx/states';
import { Button, Card, KeyValues, Notice } from '@/components/nx/ui';
import { Hash } from '@/components/ws6/common';
import { ApiRequestError } from '@/lib/api/errors';
import { newKey } from '@/lib/api/transport';
import { formatUtc } from '@/lib/format';
import { creditsApi, creditsKey, proofsApi, type Proof } from '@/lib/near/api';
import { addYocto, formatNear, txUrl, yoctoAtLeast } from '@/lib/near/units';

const POLL_MS = 3000;
const STATE_TONE: Record<Proof['state'], 'ok' | 'warn' | 'bad' | 'info'> = { verified: 'ok', not_attested: 'warn', failed: 'bad', running: 'info' };

function Opt({ v }: { v: string | null | undefined }) {
  return v ? <span className="mono small" style={{ wordBreak: 'break-all' }}>{v}</span> : <span className="dim">unknown</span>;
}

function ProofResult({ p }: { p: Proof }) {
  const txHash = p.job.txHash;
  const total = p.cost.totalYocto ?? addYocto(p.cost.chargedYocto, p.cost.gasYocto);
  return (
    <div className="col gap2" data-testid="proof-result" data-state={p.state}>
      <div className="row gap2">
        <Badge tone={STATE_TONE[p.state]}>{p.state.replace(/_/g, ' ')}</Badge>
        {p.verification.decision && <Badge outline>{p.verification.decision}</Badge>}
        <span className="tiny dim">
          Started {formatUtc(p.createdAt)}
          {p.finishedAt ? `, finished ${formatUtc(p.finishedAt)}` : ''}
        </span>
      </div>
      {p.state === 'running' && <p className="small dim">The job is running on OutLayer testnet. This page checks every 3 seconds.</p>}
      {p.error && <Notice tone="bad" title="The job failed"><span className="mono small">{p.error}</span></Notice>}
      {p.verification.reasons.length > 0 && (
        <ul className="small col gap2">
          {p.verification.reasons.map((r, i) => (
            <li key={i} className="mono">{r}</li>
          ))}
        </ul>
      )}
      <KeyValues
        rows={[
          { k: 'Request id', v: p.job.requestId ? <span className="mono">{p.job.requestId}</span> : <span className="dim">none yet</span> },
          {
            k: 'Transaction',
            v: txHash ? (
              <a className="link mono small" href={p.job.explorerUrl ?? txUrl(txHash)} target="_blank" rel="noreferrer" data-testid="proof-tx">
                {txHash}
              </a>
            ) : (
              <span className="dim">none yet</span>
            ),
          },
          { k: 'WASM SHA-256', v: <Hash value={p.wasmSha256} /> },
          { k: 'Input SHA-256', v: <Hash value={p.inputSha256} /> },
          { k: 'Output SHA-256', v: <Hash value={p.outputSha256} /> },
          { k: 'mrTd', v: <Opt v={p.verification.mrTd} /> },
          { k: 'rtmr3', v: <Opt v={p.verification.rtmr3} /> },
          { k: 'Held', v: <span className="mono">{formatNear(p.cost.heldYocto, { round: 'up' })} NEAR</span> },
          { k: 'Charged by OutLayer', v: <span className="mono">{formatNear(p.cost.chargedYocto, { round: 'up' })} NEAR</span> },
          { k: 'Gas', v: <span className="mono">{formatNear(p.cost.gasYocto, { round: 'up' })} NEAR</span> },
          { k: 'Total charged to you', v: <span className="mono strong" data-testid="proof-total">{formatNear(total, { round: 'up' })} NEAR</span> },
        ]}
      />
      {!p.verification.collateralChecked && (
        <p className="small dim" data-testid="collateral-note">Intel collateral (TCB status) not checked.</p>
      )}
    </div>
  );
}

/**
 * "Verify on OutLayer": a paid, testnet-only attestation of this capsule. The
 * user sees the maximum hold and the cost rule, confirms once, and the card then
 * polls the proof until it leaves `running`. Nothing here is estimated locally:
 * every figure comes from /v1/credits and /v1/proofs.
 */
export function OutlayerProofCard({ capsuleId }: { capsuleId: string }) {
  const qc = useQueryClient();
  const credits = useQuery({ queryKey: creditsKey, queryFn: () => creditsApi.get(), retry: false });
  const list = useQuery({ queryKey: ['capsule', capsuleId, 'proofs'], queryFn: () => proofsApi.list(capsuleId), retry: false });
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // One key per confirm attempt: a double click or a retry after a dropped response replays, never double-charges.
  const idemKey = useRef<string | null>(null);

  const latest = list.data?.items?.[0] ?? null;
  const running = list.data?.items?.find((x) => x.state === 'running') ?? null;
  const trackedId = activeId ?? running?.proofId ?? null;

  const proof = useQuery({
    queryKey: ['proof', trackedId],
    queryFn: () => proofsApi.get(trackedId as string),
    enabled: !!trackedId,
    retry: false,
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'running' ? false : POLL_MS),
  });

  // When a tracked proof finishes, refresh credits (the charge landed) and the capsule's proof list and view.
  const doneState = proof.data && proof.data.state !== 'running' ? proof.data.proofId : null;
  useEffect(() => {
    if (!doneState) return;
    void qc.invalidateQueries({ queryKey: creditsKey });
    void qc.invalidateQueries({ queryKey: ['capsule', capsuleId] });
    void qc.invalidateQueries({ queryKey: ['capsule', capsuleId, 'proofs'] });
  }, [doneState, capsuleId, qc]);

  const shown: Proof | null = proof.data ?? latest;
  const c = credits.data;
  const estimate = c?.proofEstimateYocto ?? null;
  const enough = yoctoAtLeast(c?.availableYocto, estimate);

  async function start() {
    setPending(true);
    setStartError(null);
    idemKey.current ??= newKey();
    try {
      const r = await proofsApi.start(capsuleId, idemKey.current);
      idemKey.current = null;
      setActiveId(r.proofId);
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: ['capsule', capsuleId, 'proofs'] });
      await qc.invalidateQueries({ queryKey: creditsKey });
    } catch (e) {
      // A refusal is final for this key; a transport failure keeps the key so a retry replays safely.
      if (e instanceof ApiRequestError && e.status !== 0) idemKey.current = null;
      setStartError(e);
      if (e instanceof ApiRequestError && e.reasonCode === 'ALREADY_PROVED') void qc.invalidateQueries({ queryKey: ['capsule', capsuleId, 'proofs'] });
    } finally {
      setPending(false);
    }
  }

  const err = startError instanceof ApiRequestError ? startError : null;
  const insufficient = err?.reasonCode === 'INSUFFICIENT_CREDITS' || err?.status === 402;
  const alreadyProved = err?.reasonCode === 'ALREADY_PROVED';
  const disabled = err?.reasonCode === 'PROOF_PROVIDER_DISABLED' || err?.status === 503;

  return (
    <Card
      title="Verify on OutLayer"
      subtitle="Runs this capsule in an OutLayer TEE on NEAR testnet and records the attestation. Paid from your credits."
    >
      <div className="col gap3" data-testid="outlayer-proof-card">
        {credits.isError && <ApiErrorState error={credits.error} onRetry={() => credits.refetch()} />}
        {c && (
          <KeyValues
            rows={[
              { k: 'Hold for one proof', v: <span className="mono" data-testid="proof-estimate">{formatNear(estimate, { round: 'up' })} NEAR</span> },
              { k: 'Your available credits', v: <span className="mono" data-testid="proof-available">{formatNear(c.availableYocto)} NEAR</span> },
            ]}
          />
        )}
        {c && !c.accountId && (
          <Notice tone="warn" title="No NEAR account linked">
            Link a wallet in <Link className="link" href="/settings">Settings</Link> and add credits to pay for a proof.
          </Notice>
        )}
        {c && enough === false && (
          <Notice tone="warn" title="Not enough credits">
            A proof needs {formatNear(estimate, { round: 'up' })} NEAR available; you have {formatNear(c.availableYocto)}.{' '}
            <Link className="link" href="/credits">Add credits</Link>
          </Notice>
        )}

        {!confirming ? (
          <div className="row gap2">
            <Button
              variant="primary"
              onClick={() => {
                setStartError(null);
                setConfirming(true);
              }}
              disabled={!c || running !== null || enough === false}
              disabledReason={!c ? 'Credits are not loaded' : running ? 'A proof is already running' : 'Not enough credits'}
              data-testid="proof-start"
            >
              Verify on OutLayer
            </Button>
          </div>
        ) : (
          <Notice tone="warn" title="Confirm the charge">
            <div className="col gap2" data-testid="proof-confirm">
              <span>
                This reserves up to <strong>{formatNear(estimate, { round: 'up' })} NEAR</strong> of your credits. The actual charge is the OutLayer cost plus gas
                for the transactions, taken from that reserve; the rest is released. Testnet funds only.
              </span>
              <div className="row gap2">
                <Button variant="primary" pending={pending} onClick={() => void start()} data-testid="proof-confirm-button">
                  Reserve up to {formatNear(estimate, { round: 'up' })} NEAR and verify
                </Button>
                <Button onClick={() => setConfirming(false)} disabled={pending} disabledReason="A request is in flight">
                  Cancel
                </Button>
              </div>
            </div>
          </Notice>
        )}

        {insufficient && (
          <Notice tone="bad" title="Refused: INSUFFICIENT_CREDITS">
            {err?.message} <Link className="link" href="/credits">Add credits</Link>
          </Notice>
        )}
        {alreadyProved && (
          <Notice tone="info" title="Already proved">
            <span data-testid="already-proved" data-reason="ALREADY_PROVED">This capsule already has a verified proof, shown below. No credits were held.</span>
          </Notice>
        )}
        {disabled && (
          <Notice tone="warn" title="Refused: PROOF_PROVIDER_DISABLED">
            <span data-testid="proof-disabled">Live OutLayer proofs are switched off on this server.</span>
          </Notice>
        )}
        {startError !== null && !insufficient && !alreadyProved && !disabled && (
          <Notice tone="bad" title={`Refused: ${err ? (err.reasonCode ?? err.errorCode) : 'REQUEST_FAILED'}`}>
            <span data-testid="proof-error">{err ? err.message : 'The request could not be sent.'}</span>
          </Notice>
        )}

        {list.isError && !(list.error instanceof ApiRequestError && list.error.status === 404) && <ApiErrorState error={list.error} onRetry={() => list.refetch()} />}
        {proof.isError && <ApiErrorState error={proof.error} onRetry={() => proof.refetch()} />}
        {shown ? <ProofResult p={shown} /> : !list.isPending && !list.isError && <p className="small dim">No OutLayer proof has been run for this capsule.</p>}
      </div>
    </Card>
  );
}

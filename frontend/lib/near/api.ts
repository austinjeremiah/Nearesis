import { browserApi } from '@/lib/api/browser';
import { newKey } from '@/lib/api/transport';

/** Wire types for /v1/credits, /v1/credits/topups, /v1/auth/near/link and the OutLayer proof routes. Amounts are yocto strings. */

export type CreditEntry = {
  id: string;
  kind: 'topup' | 'hold' | 'charge' | 'release' | string;
  amountYocto: string;
  refKind: string | null;
  refId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
};

export type Credits = {
  accountId: string | null;
  balanceYocto: string;
  heldYocto: string;
  availableYocto: string;
  depositAccount: string;
  network: string;
  proofEstimateYocto: string | null;
  entries: CreditEntry[];
};

export type ProofState = 'running' | 'verified' | 'not_attested' | 'failed';

export type Proof = {
  proofId: string;
  capsuleId: string;
  state: ProofState;
  requestedBy: string;
  createdAt: string;
  finishedAt: string | null;
  job: { network: string; requestId: string | null; txHash: string | null; explorerUrl: string | null };
  wasmSha256: string;
  inputSha256: string;
  outputSha256: string | null;
  verification: {
    decision: 'accept' | 'reject' | null;
    reasons: string[];
    mrTd: string | null;
    rtmr3: string | null;
    collateralChecked: boolean;
  };
  cost: { heldYocto: string | null; chargedYocto: string | null; gasYocto: string | null; totalYocto: string | null };
  error: string | null;
};

export const creditsApi = {
  get: () => browserApi.get<Credits>('/v1/credits'),
  topup: (txHash: string) => browserApi.send<Credits>('POST', '/v1/credits/topups', { txHash }),
  link: (b: { challengeId: string; accountId: string; publicKey: string; signature: string }) =>
    browserApi.send<{ accountId: string; userId: string }>('POST', '/v1/auth/near/link', b),
};

export const proofsApi = {
  list: (capsuleId: string) => browserApi.get<{ items: Proof[] }>(`/v1/capsules/${encodeURIComponent(capsuleId)}/proofs`),
  get: (proofId: string) => browserApi.get<Proof>(`/v1/proofs/${encodeURIComponent(proofId)}`),
  start: (capsuleId: string, idempotencyKey: string = newKey()) =>
    browserApi.send<{ proofId: string; state: ProofState }>('POST', `/v1/capsules/${encodeURIComponent(capsuleId)}/proofs`, {}, { idempotencyKey }),
};

export const creditsKey = ['credits'] as const;

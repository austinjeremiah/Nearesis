import { browserApi } from '@/lib/api/browser';
import { newKey } from '@/lib/api/transport';
import { normalizeCredits, type Credits } from '@/lib/credits/model';

/** Wire types for /v1/auth/near/link and the OutLayer proof routes. Credit figures live in lib/credits (USD). */

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
  /** USD first (what the account is charged); NEAR amounts and the rate are secondary detail. Fields an older API omits are undefined. */
  cost: {
    heldUsd?: string | null;
    chargedUsd?: string | null;
    gasUsd?: string | null;
    totalUsd?: string | null;
    heldYocto?: string | null;
    chargedYocto?: string | null;
    gasYocto?: string | null;
    totalYocto?: string | null;
    nearUsdRate?: string | number | null;
    rateDate?: string | null;
  };
  error: string | null;
};

export const creditsApi = {
  /** The unified USD credits, normalised (missing fields are unknown). `capsuleId` sizes `proofEstimateUsd` to that capsule. */
  get: async (capsuleId?: string): Promise<Credits> =>
    normalizeCredits(await browserApi.get<unknown>('/v1/credits', capsuleId ? { query: { capsuleId } } : undefined)),
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

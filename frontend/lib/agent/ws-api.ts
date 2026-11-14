import { proofsApi, type ProofState } from '@/lib/near/api';
import { caps as wsCaps } from '@/lib/ws6/api';

export type ProofSummary = { state: ProofState; proofId: string };

/** Capsule list rows come from the existing publications route; the proof state is the newest proof of each capsule. */
export const caps = {
  publications: () => wsCaps.publications(),
  latestProof: async (capsuleId: string): Promise<ProofSummary | null> => {
    const r = await proofsApi.list(capsuleId);
    const items = [...(r.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return items[0] ? { state: items[0].state, proofId: items[0].proofId } : null;
  },
};

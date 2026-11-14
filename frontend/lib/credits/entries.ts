import type { CreditEntry } from './model';

const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const KIND_WORDS: Record<string, string> = {
  run: 'Investigation run',
  proof: 'OutLayer proof',
  capsule: 'Capsule',
  publication: 'Publication',
  agent_task: 'Agent task',
  agent_message: 'Agent message',
  assistant_answer: 'Assistant answer',
  assistant_setup: 'Workspace setup',
  question: 'Investigation question',
  grant: 'Allowance',
};

/** What a ledger row was for: the entry's own label when it has one, else a plain name for its reference kind. */
export function entryWhat(e: Pick<CreditEntry, 'refKind' | 'refId' | 'detail' | 'kind' | 'category'>): { text: string; short: string | null } {
  const label = s(e.detail?.label) ?? s(e.detail?.title);
  const word = e.refKind ? (KIND_WORDS[e.refKind] ?? e.refKind.replace(/_/g, ' ')) : e.kind === 'grant' ? 'Allowance' : null;
  return { text: label ?? word ?? 'unknown', short: e.refId ? e.refId.slice(0, 8) : null };
}

/** An app link for the thing an entry was for, only when the entry carries enough to build one. Never a guess. */
export function entryHref(e: Pick<CreditEntry, 'refKind' | 'refId' | 'detail'>): string | null {
  const ws = s(e.detail?.workspaceId);
  const capsuleId = s(e.detail?.capsuleId) ?? (e.refKind === 'capsule' ? e.refId : null);
  const enc = encodeURIComponent;
  if (e.refKind === 'run' && ws && e.refId) return `/w/${enc(ws)}/runs/${enc(e.refId)}`;
  if (ws && capsuleId) return `/w/${enc(ws)}/capsules/${enc(capsuleId)}`;
  if (e.refKind === 'agent_task' || e.refKind === 'agent_message' || e.refKind === 'assistant_answer') return '/agent';
  return null;
}

/** The on-chain transaction hash of an entry, when there is one. */
export function entryTxHash(e: Pick<CreditEntry, 'detail'>): string | null {
  return s(e.detail?.txHash);
}

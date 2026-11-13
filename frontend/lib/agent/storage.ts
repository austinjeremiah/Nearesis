import type { AgentAnswer } from './types';
import type { PipelineState } from './pipeline';
import { markInterrupted } from './pipeline';

export type Turn =
  | { id: string; kind: 'user'; text: string; at: number }
  | { id: string; kind: 'answer'; question: string; answer: AgentAnswer; at: number }
  | { id: string; kind: 'pipeline'; pipeline: PipelineState; at: number }
  /** A question asked against an existing workspace: the run card follows it live. */
  | { id: string; kind: 'run'; workspaceId: string; runId: string; question: string; at: number };

export const STORAGE_KEY = 'nearesis.agent.conversation.v1';
export const MAX_TURNS = 30;
export const MAX_BYTES = 400_000;

/** Keep the newest turns that fit the turn and size caps. Never drops the newest turn. */
export function capTurns(turns: Turn[]): Turn[] {
  let t = turns.slice(-MAX_TURNS);
  while (t.length > 1 && JSON.stringify(t).length > MAX_BYTES) t = t.slice(1);
  return t;
}

export function loadTurns(storage: Pick<Storage, 'getItem'> | null): Turn[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return (v as Turn[])
      .filter((t) => t && typeof t === 'object' && ['user', 'answer', 'pipeline', 'run'].includes(t.kind) && typeof t.id === 'string')
      .map((t) => (t.kind === 'pipeline' ? { ...t, pipeline: markInterrupted(t.pipeline) } : t));
  } catch {
    return [];
  }
}

export function saveTurns(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, turns: Turn[]): void {
  try {
    if (!storage) return;
    if (turns.length === 0) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(capTurns(turns)));
  } catch {
    /* private mode or quota: the conversation just is not remembered */
  }
}

export function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Which context the chat works in: quick answers (no workspace), a new workspace, or an existing workspace id. */
export type AgentContext = 'quick' | 'new' | string;
export const CTX_KEY = 'nearesis.agent.context.v1';
export function loadContext(storage: Pick<Storage, 'getItem'> | null): AgentContext {
  try {
    const v = storage?.getItem(CTX_KEY);
    return typeof v === 'string' && v.length > 0 && v.length < 80 ? v : 'quick';
  } catch {
    return 'quick';
  }
}
export function saveContext(storage: Pick<Storage, 'setItem'> | null, ctx: AgentContext): void {
  try {
    storage?.setItem(CTX_KEY, ctx);
  } catch {
    /* not remembered */
  }
}

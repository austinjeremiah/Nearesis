import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { newKey } from '@/lib/api/transport';
import { normalizeSetup, type AgentSetup } from './types';
import { normalizeCosts, normalizeMessage, normalizeTask, normalizeThread, normalizeThreadDetail, type Costs, type Task, type Thread, type ThreadDetail, type ThreadMessage } from './thread';

/** A 404 on an agent endpoint means this API does not have it (or the thread is not yours). */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiRequestError && (e.status === 404 || e.status === 405 || e.status === 501);
}

const th = (id: string) => `/v1/agent/threads/${encodeURIComponent(id)}`;
const tk = (id: string) => `/v1/agent/tasks/${encodeURIComponent(id)}`;

export const agentKeys = {
  threads: ['agent', 'threads'] as const,
  thread: (id: string) => ['agent', 'thread', id] as const,
  costs: (threadId: string | null) => ['agent', 'costs', threadId ?? 'all'] as const,
};

export const agentApi = {
  threads: async (): Promise<Thread[]> => {
    const r = await browserApi.get<{ items?: unknown[] }>('/v1/agent/threads');
    return (Array.isArray(r?.items) ? r.items : []).map(normalizeThread);
  },
  createThread: async (body: { title?: string; workspaceId?: string | null } = {}): Promise<Thread> =>
    normalizeThread(await browserApi.send<unknown>('POST', '/v1/agent/threads', body)),
  thread: async (id: string, signal?: AbortSignal): Promise<ThreadDetail> => normalizeThreadDetail(await browserApi.get<unknown>(th(id), { signal })),
  patchThread: async (id: string, body: { title?: string; workspaceId?: string | null }): Promise<Thread> =>
    normalizeThread(await browserApi.send<unknown>('PATCH', th(id), body)),
  deleteThread: (id: string) => browserApi.send<unknown>('DELETE', th(id)),
  /** A model call is charged: a new message is always new work, so no idempotency key is sent. */
  send: async (id: string, body: { text: string; workspaceId?: string | null }): Promise<{ userMessage: ThreadMessage; reply: ThreadMessage }> => {
    const r = await browserApi.send<{ userMessage?: unknown; reply?: unknown }>('POST', `${th(id)}/messages`, body, { idempotencyKey: false });
    return { userMessage: normalizeMessage(r?.userMessage), reply: normalizeMessage(r?.reply) };
  },

  task: async (id: string): Promise<Task> => normalizeTask(await browserApi.get<unknown>(tk(id))),
  start: async (id: string, consent: string[]): Promise<Task> => normalizeTask(await browserApi.send<unknown>('POST', `${tk(id)}/start`, { consent }, { idempotencyKey: newKey() })),
  cancel: async (id: string): Promise<Task> => normalizeTask(await browserApi.send<unknown>('POST', `${tk(id)}/cancel`, {})),
  retry: async (id: string): Promise<Task> => normalizeTask(await browserApi.send<unknown>('POST', `${tk(id)}/retry`, {})),
  approval: async (id: string, idx: number, decision: 'approve' | 'reject'): Promise<unknown> =>
    browserApi.send<unknown>('POST', `${tk(id)}/steps/${idx}/approval`, { decision }),

  costs: async (threadId: string | null, limit = 200): Promise<Costs> =>
    normalizeCosts(await browserApi.get<unknown>('/v1/agent/costs', { query: { threadId: threadId ?? undefined, limit } })),

  /** Existing route kept for workspaces: markers, monitors and a draft hypothesis from a completed run. */
  setup: async (wid: string, runId: string, idempotencyKey: string, signal?: AbortSignal): Promise<AgentSetup> =>
    normalizeSetup(await browserApi.send<unknown>('POST', `/v1/workspaces/${encodeURIComponent(wid)}/assistant/setup`, { runId }, { idempotencyKey, signal })),
  archiveWorkspace: (wid: string) => browserApi.send<unknown>('POST', `/v1/workspaces/${encodeURIComponent(wid)}/archive`, {}),
};

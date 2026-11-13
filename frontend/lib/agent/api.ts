import { browserApi } from '@/lib/api/browser';
import { ApiRequestError } from '@/lib/api/errors';
import { normalizeAnswer, normalizeSetup, type AgentAnswer, type AgentSetup, type HistoryEntry } from './types';

/** A 404 on an agent endpoint means this API does not have it yet. */
export function isUnavailable(e: unknown): boolean {
  return e instanceof ApiRequestError && (e.status === 404 || e.status === 405 || e.status === 501);
}

export const agentApi = {
  /** Model calls are charged: a new request is always a new answer, so no idempotency key is sent. */
  answer: async (question: string, history: HistoryEntry[], signal?: AbortSignal): Promise<AgentAnswer> =>
    normalizeAnswer(
      await browserApi.send<unknown>('POST', '/v1/assistant/answer', history.length ? { question, history } : { question }, {
        idempotencyKey: false,
        signal,
      }),
    ),
  setup: async (wid: string, runId: string, idempotencyKey: string, signal?: AbortSignal): Promise<AgentSetup> =>
    normalizeSetup(
      await browserApi.send<unknown>('POST', `/v1/workspaces/${encodeURIComponent(wid)}/assistant/setup`, { runId }, { idempotencyKey, signal }),
    ),
};

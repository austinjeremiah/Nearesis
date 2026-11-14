import { browserApi } from '@/lib/api/browser';
import { newKey } from '@/lib/api/transport';
import type {
  Budget,
  GlobalApprovals,
  QuestionPreview,
  RunApprovals,
  RunDetail,
  RunListItem,
  RunTasks,
} from './types';

/**
 * Investigation routes. Kept out of lib/api/client.ts (shared) so this stream
 * owns its own surface. All calls go through the same-origin BFF.
 */
const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;
const run = (id: string) => `/v1/runs/${encodeURIComponent(id)}`;

export const investigateApi = {
  runs: (wid: string) => browserApi.get<{ workspaceId: string; runs: RunListItem[] }>(`${ws(wid)}/runs`),
  run: (runId: string) => browserApi.get<RunDetail>(run(runId)),
  tasks: (runId: string) => browserApi.get<RunTasks>(`${run(runId)}/tasks`),
  approvals: (runId: string) => browserApi.get<RunApprovals>(`${run(runId)}/approvals`, { query: { status: 'all' } }),
  globalApprovals: (status: 'pending' | 'all') => browserApi.get<GlobalApprovals>('/v1/approvals', { query: { status } }),
  preview: (wid: string, body: { question: string; source: 'fixture' | 'live'; budget?: Budget }) =>
    browserApi.send<QuestionPreview>('POST', `${ws(wid)}/questions/preview`, body, { idempotencyKey: false }),
  ask: (
    wid: string,
    body: { question: string; snapshotPolicy: 'live' | 'pinned'; source: 'fixture' | 'live'; budget: Budget; priority?: 'normal' | 'low' },
    idempotencyKey: string,
  ) => browserApi.send<{ runId: string; workflowId: string }>('POST', `${ws(wid)}/questions`, body, { idempotencyKey }),
  decide: (runId: string, approvalId: string, decision: 'approve' | 'reject', actionHash: string) =>
    browserApi.send<unknown>('POST', `${run(runId)}/approvals/${encodeURIComponent(approvalId)}`, { decision, actionHash }),
  cancel: (runId: string, expectedVersion: number) =>
    browserApi.send<{ runId: string; state: string; cancelRequested: boolean }>('POST', `${run(runId)}/cancel`, { expectedVersion }),
};

export { newKey };

/** Query keys. Run-scoped keys start with ['ws', wid, 'run'] so the SSE hub's run events invalidate them. */
export const ik = {
  run: (wid: string, runId: string) => ['ws', wid, 'run', runId] as const,
  tasks: (wid: string, runId: string) => ['ws', wid, 'run', runId, 'tasks'] as const,
  approvals: (wid: string, runId: string) => ['ws', wid, 'run', runId, 'approvals'] as const,
  wsApprovals: (wid: string, status: string) => ['ws', wid, 'approvals', status] as const,
};

export const ACTIVE_STATES = new Set(['REQUESTED', 'PLANNING', 'APPROVAL_NEEDED', 'EXECUTING', 'EVIDENCE_REVIEW', 'CANVAS_PATCH_REVIEW']);

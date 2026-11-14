import { requestJson, type RequestOptions, type Transport } from './transport';
import type { CanvasSummary, WorkspaceDetail, Ok, PublicationEligibility, TimelineResponse } from './types';

/**
 * Typed async API client. Replaces the old synchronous fixture adapter:
 * same names where a name existed (`workspaces`, `workspace`, `runs`,
 * `timeline`, `monitors`, `markers`, `sources`, `notifications`), but every
 * function is async, takes the workspace UUID, returns the generated
 * response type, and throws ApiRequestError (carrying the 12-state mapping).
 *
 * Add a function here per route as a stream needs it; use `get`/`send` for
 * routes not wrapped yet (the path is checked at runtime by the API, the
 * result type is whatever you pass).
 */
export function createApi(transport: Transport) {
  const get = <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) =>
    requestJson<T>(transport, path, { ...opts, method: 'GET' });
  const send = <T>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ) => requestJson<T>(transport, path, { ...opts, method, body });

  const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;

  return {
    get,
    send,
    // workspaces
    workspaces: (o?: RequestOptions) => get<Ok<'getWorkspaces'>>('/v1/workspaces', o),
    workspace: (wid: string, o?: RequestOptions) => get<WorkspaceDetail>(ws(wid), o),
    createWorkspace: (body: unknown, o?: RequestOptions) =>
      send<Ok<'postWorkspaces'>>('POST', '/v1/workspaces', body, o),
    summaries: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdSummaries'>>(`${ws(wid)}/summaries`, o),
    // investigation
    runs: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdRuns'>>(`${ws(wid)}/runs`, o),
    run: (runId: string, o?: RequestOptions) => get<Ok<'getRunsById'>>(`/v1/runs/${encodeURIComponent(runId)}`, o),
    runApprovals: (runId: string, o?: RequestOptions) =>
      get<Ok<'getRunsByIdApprovals'>>(`/v1/runs/${encodeURIComponent(runId)}/approvals`, o),
    askQuestion: (wid: string, body: unknown, o?: RequestOptions) =>
      send<Ok<'postWorkspacesByIdQuestions'>>('POST', `${ws(wid)}/questions`, body, o),
    // research surface
    timeline: (wid: string, o?: RequestOptions) => get<TimelineResponse>(`${ws(wid)}/timeline`, o),
    canvas: (wid: string, o?: RequestOptions) => get<CanvasSummary>(`${ws(wid)}/canvas`, o),
    graph: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdGraph'>>(`${ws(wid)}/graph`, o),
    markers: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdMarkers'>>(`${ws(wid)}/markers`, o),
    monitors: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdMonitors'>>(`${ws(wid)}/monitors`, o),
    notifications: (wid: string, o?: RequestOptions) =>
      get<Ok<'getWorkspacesByIdNotifications'>>(`${ws(wid)}/notifications`, o),
    sources: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdSources'>>(`${ws(wid)}/sources`, o),
    publicationEligibility: (wid: string, o?: RequestOptions) =>
      get<PublicationEligibility>(`${ws(wid)}/publication-eligibility`, o),
    snapshots: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdSnapshots'>>(`${ws(wid)}/snapshots`, o),
    branches: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdBranches'>>(`${ws(wid)}/branches`, o),
    costBurn: (wid: string, o?: RequestOptions) => get<Ok<'getWorkspacesByIdCostBurn'>>(`${ws(wid)}/cost/burn`, o),
    // capsules and ops
    capsules: (o?: RequestOptions) => get<Ok<'getCapsules'>>('/v1/capsules', o),
    opsSlo: (o?: RequestOptions) => get<Ok<'getOpsSlo'>>('/v1/ops/slo', o),
  };
}

export type Api = ReturnType<typeof createApi>;

import { requestJson, type RequestOptions, type Transport } from './transport';

/**
 * Shell-level API calls: identity, org, notifications, approvals, source health,
 * global spend, templates, workspace profile, invites. Shapes are the observed
 * wire format of the routes (the generated OpenAPI types leave these open).
 */

export type Role = 'owner' | 'admin' | 'analyst' | 'viewer';

export type MeResponse = {
  principal: { userId: string; kind: 'human' | 'agent' | 'service'; displayName: string | null };
  org: { id: string; name: string };
  role: Role;
  roles: Role[];
  permissions: { canWrite: boolean; canAdmin: boolean };
  workspaces: { id: string; objective: string; networkScope: string; createdAt: string }[];
};

export type GlobalNotification = {
  notificationId: string;
  workspaceId: string;
  workspaceObjective: string;
  ruleId: string | null;
  triggerId: string | null;
  markerId: string | null;
  mode: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};
export type GlobalNotificationList = {
  notifications: GlobalNotification[];
  unread: number;
  truncated: boolean;
  workspaceCount: number;
};

/** Marks read for the calling user only. `unread` is the caller's count after the change. */
export type MarkReadResult = { marked: string[]; alreadyRead: number; notFound: string[]; unread: number };

export type GlobalApproval = {
  approvalId: string;
  runId: string;
  workspaceId: string;
  workspaceObjective: string;
  runState: string;
  actionHash: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  kind: string | null;
  network: string | null;
  costLimit: number | null;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
};
export type GlobalApprovalList = { approvals: GlobalApproval[]; truncated: boolean; workspaceCount: number };

export type SourceHealthRow = {
  sourceId: string;
  state: string;
  watermark: string | null;
  lagSeconds: number | null;
  gapCount: number | null;
  coveragePct: number | null;
  coverageWindow: { from: string; to: string; days: number } | null;
  datasets: {
    dataset: string;
    completeDays: number;
    partialDays: number;
    unavailableDays: number;
    missingDays: number;
    coveragePct: number | null;
  }[];
  recentErrors: { code?: string; message?: string; firstSeen?: string; lastSeen?: string; count?: number }[];
  rateLimit: unknown;
  schemaVersion: string | null;
};
export type GlobalSourceList = { sources: SourceHealthRow[] };

export type GlobalSpend = {
  scope: 'global';
  currency: 'USD';
  ceilingUsd: number;
  hardMaxUsd: number;
  settledUsd: number;
  reservedUsd: number;
  externalUsd: number;
  committedUsd: number;
  remainingUsd: number;
  fraction: number;
  state: string;
  unknownPriceEntries: number;
  thresholds: { fraction: number; usd: number; reached: boolean }[];
  forecast: {
    label: string;
    method: string;
    assumptions: string[];
    rate24hUsdPerHour: number | null;
    projectedExhaustionAt: string | null;
    projected30DayUsd: number | null;
    confidence: string;
  };
  asOf: string;
};

export type WorkspaceBurnLite = {
  workspaceId: string;
  spentUsd: number | null;
  reservedUsd: number | null;
  capUsd: number | null;
  burnFraction: number | null;
  hardStopped: boolean;
  hardStopReason: string | null;
};

export type Org = { orgId: string; name: string; memberCount: number; myRole: Role; roles: Role[] };
export type Member = { userId: string; displayName: string | null; role: Role; you: boolean };
export type Invite = {
  inviteId: string;
  email: string;
  role: Role;
  workspaceId: string | null;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};
export type CreatedInvite = {
  inviteId: string;
  email: string;
  role: Role;
  workspaceId: string | null;
  expiresAt: string;
  token: string;
  acceptPath: string;
};
export type InvitePreview = {
  inviteId: string;
  orgName: string;
  role: Role;
  workspaceId: string | null;
  email: string;
  expiresAt: string;
  state: string;
};

export type Template = {
  id: string;
  name: string;
  description: string | null;
  objectiveHint: string | null;
  starterQuestions: string[];
  kind: 'builtin' | 'org';
};

export type WorkspaceSettings = {
  workspaceId: string;
  name: string | null;
  displayName: string;
  description: string | null;
  objective: string;
  networkScope: string;
  template: { id: string; name: string } | null;
  pinned: boolean;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  collaborators: number;
  collaboratorScope: 'org';
  myRole: Role;
};
export type Collaborators = {
  workspaceId: string;
  scope: 'org';
  collaborators: Member[];
  pendingInvites: { inviteId: string; email: string; role: Role; expiresAt: string }[] | null;
};

export type OpsSlo = {
  slos: {
    slo: { id: string; title: string; objective: number; periodDays: number };
    asOf: string;
    firing: boolean;
    budgetConsumed: number | null;
    rules: { rule: { severity: string }; firing: boolean }[];
  }[];
};

export function createShellApi(transport: Transport) {
  const get = <T>(path: string, o?: RequestOptions) => requestJson<T>(transport, path, { ...o, method: 'GET' });
  const send = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, o?: RequestOptions) =>
    requestJson<T>(transport, path, { ...o, method, body });
  const ws = (wid: string) => `/v1/workspaces/${encodeURIComponent(wid)}`;
  return {
    me: (o?: RequestOptions) => get<MeResponse>('/v1/me', o),
    pins: (o?: RequestOptions) => get<{ pins: { workspaceId: string; pinnedAt: string }[] }>('/v1/me/pins', o),
    notifications: (q?: { unread?: boolean; limit?: number }, o?: RequestOptions) =>
      get<GlobalNotificationList>('/v1/notifications', { ...o, query: { unread: q?.unread ? 1 : undefined, limit: q?.limit } }),
    markNotificationsRead: (which: { ids: string[] } | { all: true }, o?: RequestOptions) =>
      send<MarkReadResult>('POST', '/v1/notifications/read', which, o),
    markWorkspaceNotificationsRead: (wid: string, which: { ids: string[] } | { all: true }, o?: RequestOptions) =>
      send<MarkReadResult>('POST', `${ws(wid)}/notifications/read`, which, o),
    approvals: (status: 'pending' | 'all' = 'pending', o?: RequestOptions) =>
      get<GlobalApprovalList>('/v1/approvals', { ...o, query: { status } }),
    sources: (o?: RequestOptions) => get<GlobalSourceList>('/v1/sources', o),
    costGlobal: (o?: RequestOptions) => get<GlobalSpend>('/v1/cost/global', o),
    workspaceBurn: (wid: string, o?: RequestOptions) => get<WorkspaceBurnLite>(`${ws(wid)}/cost/burn`, o),
    opsSlo: (o?: RequestOptions) => get<OpsSlo>('/v1/ops/slo', o),
    org: (o?: RequestOptions) => get<Org>('/v1/org', o),
    members: (o?: RequestOptions) => get<{ members: Member[] }>('/v1/org/members', o),
    setMemberRole: (userId: string, role: Role, o?: RequestOptions) =>
      send<unknown>('PATCH', `/v1/org/members/${encodeURIComponent(userId)}`, { role }, o),
    removeMember: (userId: string, o?: RequestOptions) =>
      send<unknown>('DELETE', `/v1/org/members/${encodeURIComponent(userId)}`, undefined, o),
    invites: (o?: RequestOptions) => get<{ invites: Invite[] }>('/v1/org/invites', o),
    createInvite: (body: { email: string; role: Exclude<Role, 'owner'>; workspaceId?: string; ttlHours?: number }, o?: RequestOptions) =>
      send<CreatedInvite>('POST', '/v1/org/invites', body, o),
    revokeInvite: (inviteId: string, o?: RequestOptions) =>
      send<unknown>('DELETE', `/v1/org/invites/${encodeURIComponent(inviteId)}`, undefined, o),
    invitePreview: (token: string, o?: RequestOptions) => get<InvitePreview>('/v1/invites/preview', { ...o, query: { token } }),
    acceptInvite: (token: string, o?: RequestOptions) =>
      send<{ accepted: boolean; orgId: string; role: Role; workspaceId: string | null }>('POST', '/v1/invites/accept', { token }, o),
    templates: (o?: RequestOptions) => get<{ templates: Template[] }>('/v1/workspace-templates', o),
    createFromTemplate: (
      body: { templateId: string; name: string; description?: string; objective?: string; networkScope: string; idempotencyKey: string },
      o?: RequestOptions,
    ) => send<WorkspaceSettings & { version: number }>('POST', '/v1/workspaces/from-template', body, o),
    settings: (wid: string, o?: RequestOptions) => get<WorkspaceSettings>(`${ws(wid)}/settings`, o),
    patchSettings: (wid: string, body: { name?: string; description?: string | null }, o?: RequestOptions) =>
      send<WorkspaceSettings>('PATCH', `${ws(wid)}/settings`, body, o),
    setPinned: (wid: string, pinned: boolean, o?: RequestOptions) =>
      send<{ workspaceId: string; pinned: boolean }>(pinned ? 'PUT' : 'DELETE', `${ws(wid)}/pin`, undefined, o),
    setArchived: (wid: string, archived: boolean, o?: RequestOptions) =>
      send<WorkspaceSettings>('POST', `${ws(wid)}/${archived ? 'archive' : 'unarchive'}`, undefined, o),
    collaborators: (wid: string, o?: RequestOptions) => get<Collaborators>(`${ws(wid)}/collaborators`, o),
  };
}

import type { operations, components } from '@/lib/contracts/generated';

/** JSON body of the 200 response of an operation, from the generated OpenAPI types. */
export type Ok<Op extends keyof operations> = operations[Op] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : operations[Op] extends { responses: { 201: { content: { 'application/json': infer T } } } }
    ? T
    : unknown;

export type Schemas = components['schemas'];

/** Who is signed in. `source` says where the data came from (a real /v1/me, or the session token itself). */
export type Me = {
  subject: string;
  orgId: string | null;
  displayName: string | null;
  email: string | null;
  role: string | null;
  source: 'api' | 'token';
};

/**
 * Responses the backend marks `x-schema-status: untyped` (no zod contract yet), so the
 * generated types are empty. Shapes below are the observed wire format; move to the
 * generated types when the backend types them.
 */
export type TimelineEntry = {
  seq: number;
  at: string;
  kind: string;
  type: string;
  summary: string;
  actorKind: 'human' | 'agent' | 'system' | string;
  actorId: string | null;
  ref: string | null;
  documentRevision: number | null;
};
export type TimelineResponse = { entries: TimelineEntry[] };

export type PublicationEligibility = {
  workspaceId: string;
  graphVersion: number;
  supportedClaimIds: string[];
  publicationEligibleIds: string[];
  publishedNumbers: unknown[];
  unsupportedSection: { label: string; claims: { claimId: string; label: string; missing: string[] }[] };
};

export type CanvasPanelSummary = { panelId: string; title: string; kind: string; layout?: { x: number; y: number; w: number; h: number } };
export type CanvasSummary = { id: string; documentRevision: number; dataRevision: number; panels: CanvasPanelSummary[] };

export type WorkspaceDetail = {
  id: string;
  orgId: string;
  objective: string;
  networkScope: string;
  activeBranchId: string | null;
  version: number;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
};

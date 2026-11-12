import { z } from "zod";
import { ChartData } from "./canvas.ts";
import { IsoDateTime, Sha256Hex, Uuid } from "./common.ts";
import { ApiState } from "./openapi-states.ts";
import { RollupFreshness } from "./semantic.ts";

/**
 * v1.9.0 (additive): the API surface a standalone frontend needs without importing any monorepo package.
 * Nothing here changes an existing contract; every shape is new.
 */

// ---- panel data over HTTP --------------------------------------------------------------------------------------------

const PanelCost = z.strictObject({
  bytesEstimated: z.number().nonnegative(),
  bytesBilled: z.number().nonnegative(),
});

/**
 * `GET /v1/workspaces/:id/panels/:hash/data`. One route for both panel kinds; `kind` says which stored query the hash named:
 *   semantic  : a certified or authored semantic query, executed by the guarded gateway with a server-bound session.
 *   analytics : a stored analytics-capability call (intents, entities, accounts), re-executed (never a certified metric).
 * `chart`, `shape`, `provenance` and `gaps` keep the shape of the old web BFF `panelData()`; the rest is new.
 * `cannotCompute` set (HTTP 200): the source can no longer answer; `chart` is null and `state` is `insufficient_data`.
 */
export const PanelDataResponse = z.strictObject({
  kind: z.enum(["semantic", "analytics"]),
  workspaceId: Uuid,
  queryHash: Sha256Hex,
  /** The twelve-state taxonomy: complete, partial, stale, truncated or insufficient_data for this response. */
  state: ApiState,
  chart: ChartData.nullable(),
  shape: z
    .strictObject({
      queryHash: Sha256Hex,
      grain: z.string().optional(),
      fields: z.array(
        z.looseObject({
          name: z.string(),
          unit: z.string().nullable(),
          role: z.enum(["time", "measure", "dimension"]),
        }),
      ),
    })
    .nullable(),
  provenance: z
    .looseObject({
      queryHash: Sha256Hex,
      semanticVersion: z.string(),
      semanticModelHash: z.string(),
      sourceSnapshotId: z.string().nullable(),
      rawManifestHash: z.string().nullable(),
      certification: z.enum(["certified", "experimental", "partial", "stale"]),
      sourceLabel: z.enum(["LIVE", "SYNTHETIC", "ANALYTICS"]),
      resultHash: Sha256Hex,
      sources: z.array(z.string()),
      ast: z.unknown(),
    })
    .nullable(),
  gaps: z.array(z.strictObject({ from: z.string(), to: z.string(), reason: z.string() })),
  /** What the answer covers: per-row coverage and counts (semantic) or the analytics coverage block with its missing days. */
  coverage: z.looseObject({}).nullable(),
  /** Overall freshness plus the watermark of each source behind the result. */
  freshness: z.strictObject({
    state: z.enum(["fresh", "late", "partial", "unavailable"]),
    sourceWatermark: IsoDateTime.nullable(),
    sourceWatermarks: z.record(z.string(), IsoDateTime.nullable()),
    generatedAt: IsoDateTime.nullable(),
  }),
  /** Build vintage of the pre-aggregation that served a semantic result; null for analytics results and old cache entries. */
  rollupFreshness: RollupFreshness.nullable(),
  cost: PanelCost.nullable(),
  nullCount: z.number().int().nonnegative().nullable(),
  partialCount: z.number().int().nonnegative().nullable(),
  caveats: z.array(z.string()),
  metricStatus: z.enum(["draft", "validated"]).optional(),
  exploratory: z.looseObject({}).optional(),
  cannotCompute: z.strictObject({ missing: z.array(z.string()), explanation: z.string() }).nullable(),
});
export type PanelDataResponse = z.infer<typeof PanelDataResponse>;

// ---- previews (no side effects) ----------------------------------------------------------------------------------------

const QueryEstimate = z.strictObject({
  panelId: Uuid,
  op: z.enum(["addPanel", "updatePanel"]),
  queryHash: Sha256Hex.nullable(),
  kind: z.enum(["semantic", "analytics", "none"]),
  /** estimated: gateway estimate; not_estimable: no stored query, an analytics call or a rejection (see reasonCode). */
  status: z.enum(["estimated", "not_estimable"]),
  estimatedRows: z.number().int().nonnegative().nullable(),
  bytesEstimated: z.number().nonnegative().nullable(),
  withinCap: z.boolean().nullable(),
  cached: z.boolean().nullable(),
  reasonCode: z.string().nullable(),
});

/**
 * `POST /v1/workspaces/:id/canvas/preview` (body: a CanvasPatch). Pure: no write, no event, no run, no spend. Validation
 * failures are 422 PATCH_REJECTED with per-operation issues, as before in the web BFF.
 */
export const CanvasPreviewResponse = z.strictObject({
  previewHash: Sha256Hex,
  baseRevision: z.number().int().nonnegative(),
  operations: z.array(z.looseObject({})),
  estimate: z.strictObject({
    queryCount: z.number().int().nonnegative(),
    estimatedRows: z.number().int().nonnegative(),
    bytesEstimated: z.number().nonnegative(),
    /** ClickHouse and Cube reads on the local stack have no per-query price. Null is never a zero price. */
    estimatedCostUsd: z.number().nonnegative().nullable(),
    costBasis: z.string(),
    /** Panels whose data the patch would leave unservable: cap exceeded, unknown stored query, source coverage unknown. */
    atRiskPanelIds: z.array(Uuid),
    removedPanelIds: z.array(Uuid),
    queries: z.array(QueryEstimate),
  }),
});
export type CanvasPreviewResponse = z.infer<typeof CanvasPreviewResponse>;

export const QuestionPreviewRequest = z.strictObject({
  question: z.string().min(1).max(4000),
  source: z.enum(["fixture", "live"]).default("fixture"),
  budget: z
    .strictObject({
      tokens: z.number().int().positive(),
      toolCalls: z.number().int().positive().max(24),
      usd: z.number().nonnegative(),
    })
    .optional(),
});
export type QuestionPreviewRequest = z.infer<typeof QuestionPreviewRequest>;

/**
 * `POST /v1/workspaces/:id/questions/preview`. Plans without starting a run: no workflow, no budget row, no model call, no
 * spend. `planKind: "deterministic_composer"` (live questions) is the exact plan the run would execute. Fixture-source
 * plans come from the director model, so no plan is shown (`planKind: "director_model"`, `plan: null`): previewing would
 * cost a model call. Either way the run itself stops at an approval before any canvas change.
 */
export const QuestionPreviewResponse = z.strictObject({
  planKind: z.enum(["deterministic_composer", "director_model"]),
  deterministic: z.boolean(),
  modelCalls: z.literal(0),
  spendUsd: z.literal(0),
  plan: z
    .strictObject({
      stages: z.array(
        z.array(
          z.strictObject({
            task: z.string(),
            role: z.string(),
            objective: z.string(),
            capabilities: z.array(z.string()),
            budget: z.strictObject({ tokens: z.number(), toolCalls: z.number(), usd: z.number() }),
          }),
        ),
      ),
      privilegedAction: z.strictObject({
        kind: z.string(),
        requiresApproval: z.literal(true),
        network: z.string(),
        costLimit: z.number(),
      }),
    })
    .nullable(),
  note: z.string(),
  budget: z.strictObject({
    requested: z.strictObject({ tokens: z.number(), toolCalls: z.number(), usd: z.number() }),
    minimum: z.strictObject({ tokens: z.number(), toolCalls: z.number(), usd: z.number() }),
    meetsMinimum: z.boolean(),
  }),
  canStart: z.boolean(),
  blockers: z.array(z.strictObject({ reasonCode: z.string(), message: z.string() })),
});
export type QuestionPreviewResponse = z.infer<typeof QuestionPreviewResponse>;

// ---- identity and global lists -----------------------------------------------------------------------------------------

/** `GET /v1/me`. `role` is the caller's single role in the org; `roles` lists it as an array for forward compatibility. */
export const MeResponse = z.strictObject({
  principal: z.strictObject({
    userId: Uuid,
    kind: z.enum(["human", "agent", "service"]),
    displayName: z.string().nullable(),
  }),
  org: z.strictObject({ id: Uuid, name: z.string() }),
  role: z.enum(["owner", "admin", "analyst", "viewer"]),
  roles: z.array(z.enum(["owner", "admin", "analyst", "viewer"])),
  permissions: z.strictObject({ canWrite: z.boolean(), canAdmin: z.boolean() }),
  workspaces: z.array(
    z.strictObject({
      id: Uuid,
      objective: z.string(),
      networkScope: z.string(),
      createdAt: IsoDateTime,
    }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;

/** Truncation marker of a fan-out list: the cap was hit, so more rows may exist. */
const FanOut = { truncated: z.boolean(), workspaceCount: z.number().int().nonnegative() };

export const GlobalNotificationList = z.strictObject({
  notifications: z.array(
    z.strictObject({
      notificationId: Uuid,
      workspaceId: Uuid,
      workspaceObjective: z.string(),
      ruleId: Uuid,
      triggerId: Uuid,
      markerId: Uuid.nullable(),
      mode: z.enum(["live", "replay"]),
      title: z.string(),
      body: z.string(),
      createdAt: IsoDateTime,
      readAt: IsoDateTime.nullable(),
    }),
  ),
  unread: z.number().int().nonnegative(),
  ...FanOut,
});
export type GlobalNotificationList = z.infer<typeof GlobalNotificationList>;

export const GlobalApprovalList = z.strictObject({
  approvals: z.array(
    z.strictObject({
      approvalId: z.string(),
      runId: Uuid,
      workspaceId: Uuid,
      workspaceObjective: z.string(),
      runState: z.string(),
      actionHash: z.string(),
      status: z.enum(["pending", "approved", "rejected", "superseded"]),
      kind: z.string().nullable(),
      network: z.string().nullable(),
      costLimit: z.number().nullable(),
      requestedAt: IsoDateTime,
      decidedBy: z.string().nullable(),
      decidedAt: IsoDateTime.nullable(),
    }),
  ),
  ...FanOut,
});
export type GlobalApprovalList = z.infer<typeof GlobalApprovalList>;

export const PublicationList = z.strictObject({
  publications: z.array(
    z.strictObject({
      capsuleId: z.string(),
      title: z.string(),
      label: z.string(),
      createdAt: IsoDateTime.nullable(),
      workspaceId: Uuid.nullable(),
      state: z.enum(["published", "unpublished", "never_published"]),
      public: z.boolean(),
      badge: z.string().nullable(),
      publishedAt: IsoDateTime.nullable(),
      acknowledged: z.array(z.string()),
    }),
  ),
});
export type PublicationList = z.infer<typeof PublicationList>;

export const GlobalMetricList = z.strictObject({
  metrics: z.array(
    z.strictObject({
      metricKey: z.string(),
      source: z.enum(["registry", "authored"]),
      status: z.string(),
      /** Authored metrics carry an integer version, registry metrics their certified semantic version string. */
      version: z.union([z.number().int().nonnegative(), z.string()]).nullable(),
      displayName: z.string().nullable(),
      unit: z.string().nullable(),
      exploratory: z.boolean(),
      /** Workspaces of the caller's org that authored the metric; empty for registry metrics. */
      authoredIn: z.array(Uuid),
    }),
  ),
  counts: z.record(z.string(), z.number().int().nonnegative()),
  ...FanOut,
});
export type GlobalMetricList = z.infer<typeof GlobalMetricList>;

export const SourceHealth = z.strictObject({
  sourceId: z.string(),
  /** Provider state as recorded by ingestion: fresh, late, live, partial, stale, unavailable. */
  state: z.string(),
  watermark: IsoDateTime.nullable(),
  lagSeconds: z.number().nonnegative().nullable(),
  gapCount: z.number().int().nonnegative().nullable(),
  /** Mean over datasets of complete days divided by the window; null when the provider has no coverage rows. */
  coveragePct: z.number().min(0).max(100).nullable(),
  coverageWindow: z.strictObject({ from: z.string(), to: z.string(), days: z.number().int() }).nullable(),
  datasets: z.array(
    z.strictObject({
      dataset: z.string(),
      completeDays: z.number().int().nonnegative(),
      partialDays: z.number().int().nonnegative(),
      unavailableDays: z.number().int().nonnegative(),
      missingDays: z.number().int().nonnegative(),
      coveragePct: z.number().min(0).max(100),
    }),
  ),
  /** Newest quality gaps (reason codes). Ingestion keeps no separate error log, so this is the recorded error trail. */
  recentErrors: z.array(
    z.strictObject({
      dataset: z.string(),
      reasonCode: z.string(),
      state: z.string(),
      from: IsoDateTime,
      to: IsoDateTime,
    }),
  ),
  /**
   * Rate-limit state from the recorded per-source history (HTTP 429 outcomes of recent attempts). Null with
   * `rateLimitRecorded: false` when the source's history records none: never a fabricated zero.
   */
  rateLimit: z
    .strictObject({
      status: z.string(),
      detail: z.string().nullable(),
      attempts: z.number().int().nonnegative().optional(),
      limited: z.number().int().nonnegative().optional(),
      windowDays: z.number().int().positive().optional(),
      lastAttemptAt: IsoDateTime.nullable().optional(),
    })
    .nullable(),
  rateLimitRecorded: z.boolean(),
  schemaVersion: z.string().nullable(),
});
export type SourceHealth = z.infer<typeof SourceHealth>;

export const GlobalSourceList = z.strictObject({
  sources: z.array(SourceHealth),
  asOf: IsoDateTime,
  /** Set when the health store could not be read: sources is then empty and this says why. */
  unavailable: z.strictObject({ reasonCode: z.string(), message: z.string() }).nullable(),
});
export type GlobalSourceList = z.infer<typeof GlobalSourceList>;

// ---- collaboration socket ticket --------------------------------------------------------------------------------------

export const CollabTicketRequest = z.strictObject({ scope: z.enum(["layout", "notes"]).optional() });
export const CollabTicketResponse = z.strictObject({
  ticket: z.string().min(32),
  expiresAt: IsoDateTime,
  ttlSeconds: z.number().int().positive(),
  workspaceId: Uuid,
  scope: z.enum(["layout", "notes"]).nullable(),
  /** Open `wsPath` (same origin as the API) with the subprotocol `nearesis.ticket.<ticket>`; the ticket works once. */
  wsPath: z.string(),
  subprotocol: z.string(),
});
export type CollabTicketResponse = z.infer<typeof CollabTicketResponse>;

// ---- OIDC -------------------------------------------------------------------------------------------------------------

export const OidcLoginResponse = z.strictObject({
  authorizationUrl: z.string(),
  state: z.string(),
  expiresInSeconds: z.number(),
});
/** `GET /v1/auth/oidc/callback` result: the same session token `POST /v1/dev/login` returns, plus when it expires. */
export const OidcCallbackResponse = z.strictObject({
  token: z.string(),
  expiresAt: IsoDateTime.nullable(),
  returnTo: z.string().nullable(),
});
export type OidcCallbackResponse = z.infer<typeof OidcCallbackResponse>;

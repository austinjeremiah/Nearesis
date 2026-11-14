import { PRODUCT_ROUTES } from "./product-openapi.ts";
import { CREDITS_ROUTES } from "./credits-openapi.ts";
import { AGENT_ROUTES } from "./agent-openapi.ts";
import { WORKSPACE_CAPSULE_ROUTES } from "./workspace-capsule-openapi.ts";
import { REPORT_ROUTES } from "./report-openapi.ts";
import { THESIS_TRACK_ROUTES } from "./thesis-track-openapi.ts";
import { USER_THESIS_ROUTES } from "./user-thesis-openapi.ts";
import { USER_THESIS_CHALLENGE_ROUTES } from "./user-thesis-challenge-openapi.ts";
import { AnswerRequest, AnswerResponse, SetupRequest, SetupResponse } from "./assistant-routes.ts";
import { RangeQ as AccountRangeQ, HfQ as AccountHfQ, GrowthQ as AccountGrowthQ } from "./account-routes.ts";
import { z } from "zod";
import {
  AddEvidenceEdgeRequest,
  AddEvidenceNodeRequest,
  AddReviewCommentRequest,
  BranchChangeRequest,
  CommandAccepted,
  CorrectNodeRequest,
  CreateBranchRequest,
  CreateSnapshotRequest,
  CreateSummaryRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DecideMergeRequest,
  LensListResponse,
  MarkerListResponse,
  MarkerTaskListResponse,
  MonitorRuleListResponse,
  NotificationListResponse,
  ProposeMergeRequest,
  PurgeSnapshotRequest,
  ResolveConflictRequest,
  ResolveRecheckRequest,
  RetentionDeleteRequest,
  RunListResponse,
  SemanticVersionChangeRequest,
  SetClaimTierRequest,
  SetNodeRestrictionRequest,
  SourceListResponse,
  SubmitQuestionRequest,
  SubmitQuestionResponse,
  TriggerListResponse,
  UpdateNodeDataRequest,
  WorkspaceCommand,
  WorkspaceListResponse,
  CollabPresenceRequest,
  CollabUpdateRequest,
  CostPolicyBody,
  CostPolicyRecord,
  GlobalReconciliation,
  GlobalSpendStatus,
  LedgerExport,
  WorkspaceBurn,
  WorkspaceReconciliation,
  MetricRecord,
  MetricValidationReport,
  MetricVersionPin,
  AnalyticsPanelData,
  RunFindingsFields,
  CanvasPatch,
  CanvasPreviewResponse,
  CollabTicketRequest,
  CollabTicketResponse,
  GlobalApprovalList,
  GlobalMetricList,
  GlobalNotificationList,
  GlobalSourceList,
  MeResponse,
  OidcCallbackResponse,
  OidcLoginResponse,
  PanelDataResponse,
  PublicationList,
  QuestionPreviewRequest,
  QuestionPreviewResponse,
} from "@nearesis/contracts";
import type { ApiState, HttpMethod, NamedSchema, ResponseSpec, RouteSpec } from "@nearesis/contracts";

/**
 * The API route table behind `docs/api/openapi.json` (final_master_prompt s21). Request and response bodies reference the
 * zod contracts in packages/contracts; a response the route returns as a service object (no zod contract yet) is marked
 * `untyped` and shows up in the spec as `x-schema-status: untyped` so the frontend knows which shapes are not yet pinned.
 * `apps/api/test/openapi.test.ts` fails if a route registered by `buildApp` is missing here, or the reverse.
 */
const R = (
  method: HttpMethod,
  path: string,
  tag: string,
  summary: string,
  extra: Partial<RouteSpec> & { ok?: ResponseSpec | string; status?: string } = {},
): RouteSpec => {
  const { ok, status, ...rest } = extra;
  const okResp: ResponseSpec =
    typeof ok === "string" || ok === undefined ? { description: ok ?? "OK", untyped: true } : ok;
  return {
    method,
    path,
    tag,
    summary,
    auth: "bearer",
    responses: { [status ?? "200"]: okResp },
    ...rest,
  };
};
const typed = (schema: z.ZodType, description = "OK", exampleFile?: string): ResponseSpec => ({
  description,
  schema,
  ...(exampleFile ? { exampleFile } : {}),
});

const idem = [
  { name: "Idempotency-Key", description: "8-200 chars; a repeated key replays the first result." },
];
const ifMatch = [
  { name: "If-Match", description: "Workspace or run version number; a mismatch is 409 STALE_VERSION." },
];
const W = "/v1/workspaces/:id";
const S = (...s: ApiState[]) => s;

const EntityListQ = z.object({
  q: z.string().min(1).max(100).optional(),
  type: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const DayRangeQ = z.object({
  from: z.string().describe("YYYY-MM-DD"),
  to: z.string().describe("YYYY-MM-DD"),
});
const CoverageQ = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  days: z.number().int().min(1).max(400).optional(),
});
const ChangesQ = z.object({
  days: z.number().int().min(1).max(180).optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  type: z.string().optional(),
});

const IntentsWin = z.object({
  from: z.string().optional().describe("UTC day YYYY-MM-DD, inclusive"),
  to: z.string().optional().describe("UTC day YYYY-MM-DD, inclusive"),
  days: z.number().int().min(1).max(366).optional(),
  era: z.enum(["public", "private_settlement"]).optional(),
  top: z.number().int().min(1).max(200).optional(),
  /** Per route (see docs/api/openapi.json descriptions): by, side, minTerminal, granularity, dimension, measure, asOf, baselineDays, recentDays. */
  by: z.string().optional(),
  side: z.enum(["origin", "destination"]).optional(),
  minTerminal: z.number().int().min(0).optional(),
  granularity: z.enum(["day", "week", "month"]).optional(),
  dimension: z.string().optional(),
  measure: z.enum(["volume", "count"]).optional(),
  asOf: z.string().optional(),
  baselineDays: z.number().int().min(1).optional(),
  recentDays: z.number().int().min(1).optional(),
});
/** NEAR Intents answers are typed results: OK with chart, coverage and provenance, or CANNOT_COMPUTE (HTTP 200). */
const IntentsResult = z.union([
  z.looseObject({
    status: z.literal("OK"),
    metric: z.string(),
    definition: z.string(),
    window: z.looseObject({}),
    chart: z.looseObject({ kind: z.string() }),
    data: z.unknown(),
    coverage: z.looseObject({}),
    provenance: z.looseObject({}),
    caveats: z.array(z.string()),
  }),
  z.looseObject({
    status: z.literal("CANNOT_COMPUTE"),
    metric: z.string(),
    missing: z.array(z.string()),
    explanation: z.string(),
    evidence: z.unknown(),
    alternative: z.unknown().optional(),
    coverage: z.looseObject({}),
    provenance: z.looseObject({}),
  }),
]);
const DevLoginBody = z.strictObject({ oidcSubject: z.string().min(1).max(255) });
const NearVerifyBody = z.strictObject({
  challengeId: z.uuid(),
  accountId: z.string().describe("x.testnet or a 64-hex implicit account"),
  publicKey: z.string().describe("ed25519:<base58>"),
  signature: z.string().describe("base64 signature from the wallet"),
});
const DevLoginResponse = z.strictObject({ token: z.string() });
const StatusOk = z.strictObject({ status: z.literal("ok") });
const AckBody = z.strictObject({ acknowledge: z.array(z.string()).optional() });
const PublishBody = z.strictObject({ capsuleId: z.string(), acknowledge: z.array(z.string()).optional() });
const PolicyResumeResponse = z.strictObject({ resumed: z.boolean() });
const IdempotencyKeyNote = "Idempotency-Key header (8-200 chars) makes the write replay-safe.";

export const EXTRA_SCHEMAS: NamedSchema[] = [
  { name: "CostPolicyBody", schema: CostPolicyBody },
  { name: "CostPolicyRecord", schema: CostPolicyRecord },
  { name: "WorkspaceBurn", schema: WorkspaceBurn },
  { name: "LedgerExport", schema: LedgerExport },
  { name: "GlobalSpendStatus", schema: GlobalSpendStatus },
  { name: "WorkspaceReconciliation", schema: WorkspaceReconciliation },
  { name: "GlobalReconciliation", schema: GlobalReconciliation },
];

const NOT_WIRED =
  "not wired: registered when the API composition root passes the authoring service to metricRoutes (apps/api/src/metric-routes.ts)";
const MetricRecordWithReport = z.strictObject({ record: MetricRecord, report: MetricValidationReport });
const MK = "/v1/workspaces/:id/metrics";
const metricRoutes = (): RouteSpec[] =>
  [
    R("get", MK, "metrics", "Metric catalogue: registry and authored metrics with status and version", {
      capability: "certified metric catalogue",
      states: S("complete", "metric_uncertified"),
      ok: "{ metrics: [{ metricKey, source: registry|authored, status, version, unit, displayName, exploratory }] }",
    }),
    R(
      "post",
      `${MK}/proposals`,
      "metrics",
      "Propose a draft metric (DRAFT, then VALIDATED when the gate passes)",
      {
        capability: "draft metric proposals",
        body: z.strictObject({
          proposal: z.record(z.string(), z.unknown()),
          validate: z.boolean().optional(),
        }),
        role: "writer",
        status: "201",
        ok: typed(MetricRecordWithReport),
      },
    ),
    R("get", `${MK}/:key/versions`, "metrics", "Versions, audit trail and corrections of a metric", {
      capability: "draft metric proposals",
      ok: "{ versions, audit, corrections }",
    }),
    R("get", `${MK}/:key/versions/:v`, "metrics", "One metric version", { ok: typed(MetricRecord) }),
    R("put", `${MK}/:key/versions/:v`, "metrics", "Edit a never-certified draft", {
      body: z.strictObject({ proposal: z.record(z.string(), z.unknown()) }),
      role: "writer",
      ok: typed(MetricRecordWithReport),
    }),
    R(
      "post",
      `${MK}/:key/versions/:v/validate`,
      "metrics",
      "Run the validation gate (tests, reconciliation, cost)",
      { role: "writer", ok: typed(MetricRecordWithReport) },
    ),
    R(
      "post",
      `${MK}/:key/versions/:v/certify`,
      "metrics",
      "Certify a validated version (human owner/admin only)",
      { role: "admin", states: S("metric_uncertified", "permission_denied"), ok: typed(MetricRecord) },
    ),
    R(
      "post",
      `${MK}/:key/versions/:v/deprecate`,
      "metrics",
      "Deprecate a version; `correction` invalidates dependents (human owner/admin only)",
      {
        body: z.strictObject({ reason: z.string().min(5).max(1000), correction: z.boolean().optional() }),
        role: "admin",
        ok: "{ record, invalidated }",
      },
    ),
    R("post", `${MK}/:key/revisions`, "metrics", "New version of a certified metric", {
      body: z.strictObject({ proposal: z.record(z.string(), z.unknown()) }),
      role: "writer",
      status: "201",
      ok: typed(MetricRecordWithReport),
    }),
    R(
      "post",
      `${MK}/:key/versions/:v/explore`,
      "metrics",
      "Exploratory run of one version (non-certified results are labelled exploratory)",
      {
        body: z.strictObject({ from: z.string().optional(), to: z.string().optional() }).optional(),
        states: S("complete", "partial", "metric_uncertified", "insufficient_data"),
        ok: "{ envelope: DataFrameEnvelope with metricStatus and exploratory banner, record }",
      },
    ),
    R("post", `${MK}/:key/explore`, "metrics", "Exploratory run of the latest version", {
      body: z.strictObject({ from: z.string().optional(), to: z.string().optional() }).optional(),
      states: S("complete", "partial", "metric_uncertified", "insufficient_data"),
      ok: "{ envelope, record }",
    }),
    R("post", `${MK}/pins`, "metrics", "Pin certified metric versions to a snapshot", {
      body: z.strictObject({
        snapshotId: z.string().min(1).max(200),
        metrics: z
          .array(z.strictObject({ metricKey: z.string(), version: z.number().int().positive() }))
          .min(1)
          .max(50),
      }),
      role: "writer",
      ok: typed(z.strictObject({ pins: z.array(MetricVersionPin) })),
    }),
    R("get", `${MK}/pins/:snapshotId`, "metrics", "Metric version pins of a snapshot", {
      ok: typed(z.strictObject({ pins: z.array(MetricVersionPin) })),
    }),
    R(
      "post",
      `${MK}/publish-check`,
      "metrics",
      "Check that metrics may be published (422 METRIC_NOT_CERTIFIED with details otherwise)",
      {
        body: z.strictObject({
          metrics: z
            .array(z.strictObject({ metricKey: z.string(), version: z.number().int().positive().optional() }))
            .min(1)
            .max(100),
        }),
        states: S("complete", "metric_uncertified"),
        ok: typed(z.strictObject({ publishable: z.literal(true) })),
      },
    ),
  ].map((r) => ({ ...r, conditional: NOT_WIRED }));

export const ROUTES: RouteSpec[] = [
  ...PRODUCT_ROUTES,
  ...CREDITS_ROUTES,
  ...AGENT_ROUTES,
  ...WORKSPACE_CAPSULE_ROUTES,
  ...REPORT_ROUTES,
  ...THESIS_TRACK_ROUTES,
  ...USER_THESIS_ROUTES,
  ...USER_THESIS_CHALLENGE_ROUTES,
  // ---- platform ----------------------------------------------------------------------------------------------------
  R("get", "/health", "platform", "Liveness", { auth: "none", ok: typed(StatusOk) }),
  R("get", "/ready", "platform", "Readiness (database reachable)", {
    auth: "none",
    ok: typed(z.strictObject({ status: z.literal("ready") })),
    responses: {
      "200": typed(z.strictObject({ status: z.literal("ready") })),
      "503": typed(z.strictObject({ status: z.literal("unavailable") }), "A dependency is unavailable."),
    },
    states: S("source_unavailable"),
  }),
  R("post", "/v1/dev/login", "session", "Development login (route does not exist in production)", {
    auth: "none",
    body: DevLoginBody,
    ok: typed(DevLoginResponse),
    conditional: "NODE_ENV is not production",
  }),
  R("post", "/v1/session/revoke", "session", "Sign out: the presented token stops working", {
    status: "204",
    ok: { description: "Revoked; no body." },
  }),

  // ---- workspaces, canvas, graph ----------------------------------------------------------------------------------
  R("post", "/v1/workspaces", "workspace", "Create a workspace", {
    body: CreateWorkspaceRequest,
    headers: idem,
    status: "201",
    ok: typed(CreateWorkspaceResponse, "Created", "workspace-created.json"),
  }),
  R("get", "/v1/workspaces", "workspace", "List the workspaces the caller can open", {
    ok: typed(WorkspaceListResponse),
  }),
  R("get", W, "workspace", "Get a workspace (version, objective, scope)", { ok: "Workspace record" }),
  R("get", `${W}/canvas`, "canvas", "Canvas document: panels, layout, markers", {
    capability: "chart data",
    states: S("partial", "complete", "stale", "truncated"),
    ok: "Canvas document with its revision",
  }),
  R("get", `${W}/graph`, "evidence-graph", "Evidence graph projection", {
    capability: "evidence graph",
    ok: "Graph projection (nodes, edges, unresolved)",
  }),
  R("get", `${W}/events`, "streaming", "Server-sent event stream of committed workspace events", {
    capability: "streaming update events",
    query: z.object({
      cursor: z
        .string()
        .regex(/^\d+$/)
        .optional()
        .describe("Last applied seq; Last-Event-ID wins when both are sent"),
    }),
    headers: [
      { name: "Last-Event-ID", description: "Last applied seq; resumes the stream after it." },
      {
        name: "x-client-id",
        description:
          "Optional stable id of the browser tab group; with the credential it keys the 6-stream limit.",
      },
    ],
    states: S("loading", "partial", "stale", "permission_denied", "rate_limited"),
    ok: {
      description: "text/event-stream. See x-sse and docs/api/SSE.md.",
      contentType: "text/event-stream",
      exampleFile: "sse-session.txt",
    },
    responses: {
      "200": {
        description: "text/event-stream. See x-sse and docs/api/SSE.md.",
        contentType: "text/event-stream",
        exampleFile: "sse-session.txt",
      },
      "429": {
        description: "More than 6 streams for this browser. `Retry-After` header.",
        headers: { "Retry-After": { description: "Seconds to wait", schema: { type: "integer" } } },
      },
    },
  }),
  R(
    "post",
    `${W}/commands`,
    "workspace",
    "Apply a workspace command (canvas patch, markers, lenses, monitor rules, plugins)",
    {
      body: WorkspaceCommand,
      headers: [...ifMatch, ...idem],
      role: "writer",
      ok: typed(CommandAccepted, "Accepted", "command-accepted.json"),
    },
  ),

  // ---- investigations ----------------------------------------------------------------------------------------------
  R(
    "post",
    `${W}/questions`,
    "investigation",
    "Submit an analyst question (starts an investigation run; 402 BUDGET_EXCEEDED / CREDITS_EXHAUSTED when the caller has used their USD credits; the run's model USD is charged to the caller when it finishes)",
    {
      body: SubmitQuestionRequest,
      headers: idem,
      capability: "investigation progress",
      states: S("loading", "rate_limited", "budget_exhausted"),
      status: "202",
      ok: typed(
        SubmitQuestionResponse,
        "Accepted; follow progress on the event stream",
        "question-accepted.json",
      ),
    },
  ),
  R("get", `${W}/runs`, "investigation", "List investigations", {
    capability: "investigation progress",
    ok: typed(RunListResponse, "OK", "runs-list.json"),
  }),
  R("get", `${W}/sources`, "sources", "Source discovery and freshness per source", {
    capability: "source discovery",
    states: S("complete", "stale", "partial", "source_unavailable"),
    ok: typed(SourceListResponse, "OK", "sources-list.json"),
  }),
  R("get", "/v1/runs/:id", "investigation", "Run detail: state, tasks, budget usage, findings", {
    capability: "agent task state, research findings",
    states: S("loading", "partial", "complete", "budget_exhausted", "method_unvalidated"),
    description:
      "Run record with tasks, budget usage (spent/reserved/total) and failure reason, plus the interpretation stage: `findings` (grounded ResearchFindings, each number tied to a result row, labelled observation or inference, with limitations and skeptic notes) and `interpretation` (state ready, unavailable with a reason, or none). Findings stream as `finding.created` events.",
    ok: typed(
      RunFindingsFields,
      "Run record (loose object: the run fields are listed in the description) with findings and interpretation",
    ),
  }),
  R("post", "/v1/runs/:id/cancel", "investigation", "Cancel a run", {
    headers: ifMatch,
    status: "202",
    ok: "Cancel requested (runId, state, cancelRequested)",
  }),
  R("get", "/v1/runs/:id/approvals", "investigation", "List approvals for a run", {
    query: z.object({ status: z.enum(["pending", "all"]).optional() }),
    ok: "Approvals",
  }),
  R("post", "/v1/runs/:id/approvals/:approvalId", "investigation", "Grant or reject an approval", {
    status: "202",
    ok: "Decision delivered",
  }),

  // ---- history: evidence graph, snapshots, branches, merges, collaboration ---------------------------------------
  R("post", `${W}/graph/nodes`, "evidence-graph", "Add an evidence node", {
    body: AddEvidenceNodeRequest,
    headers: idem,
    status: "201",
    ok: "Node (201 created, 200 replayed)",
    description: IdempotencyKeyNote,
  }),
  R("post", `${W}/graph/edges`, "evidence-graph", "Add an evidence edge", {
    body: AddEvidenceEdgeRequest,
    headers: idem,
    status: "201",
    ok: "Edge (201 created, 200 replayed)",
  }),
  R(
    "post",
    `${W}/graph/semantic-changes`,
    "evidence-graph",
    "Record a semantic version change; flags dependents for recheck",
    { body: SemanticVersionChangeRequest, headers: idem, ok: "Impact result" },
  ),
  R("post", `${W}/graph/rechecks/resolve`, "evidence-graph", "Resolve a recheck flag", {
    body: ResolveRecheckRequest,
    headers: idem,
    ok: "Resolution",
  }),
  R("get", `${W}/graph/rechecks`, "evidence-graph", "Open recheck flags", { ok: "{ flags }" }),
  R("post", `${W}/graph/nodes/data`, "evidence-graph", "Update a node's data (new vintage)", {
    body: UpdateNodeDataRequest,
    headers: idem,
    ok: "Node",
  }),
  R("post", `${W}/graph/corrections`, "evidence-graph", "Correct a node (tombstone and replace)", {
    body: CorrectNodeRequest,
    headers: idem,
    ok: "Correction",
  }),
  R("post", `${W}/graph/restrictions`, "evidence-graph", "Restrict or release a node", {
    body: SetNodeRestrictionRequest,
    headers: idem,
    ok: "Node",
  }),
  R("get", `${W}/impact/:metric`, "evidence-graph", "Impact analysis of a metric version", {
    query: z.object({ maxDepth: z.number().int().min(1).max(1000).optional() }),
    ok: "Impact tree, ACL filtered",
  }),
  R("get", `${W}/revalidation`, "evidence-graph", "Revalidation status", { ok: "Status" }),
  R(
    "get",
    `${W}/publication-eligibility`,
    "publication",
    "Supported-publication eligibility; unsupported claims listed apart",
    {
      capability: "publications",
      states: S("complete", "insufficient_data", "method_unvalidated", "metric_uncertified"),
      ok: "Eligibility with missing provenance",
    },
  ),
  R("post", `${W}/comments`, "history", "Add a review comment", {
    body: AddReviewCommentRequest,
    headers: idem,
    status: "201",
    ok: "Comment",
  }),
  R("get", `${W}/comments`, "history", "List review comments", {
    query: z.object({ nodeId: z.string().optional() }),
    ok: "{ comments }",
  }),
  R("post", `${W}/summaries`, "history", "Create an analyst summary", {
    body: CreateSummaryRequest,
    headers: idem,
    status: "201",
    ok: "Summary",
  }),
  R("get", `${W}/summaries`, "history", "List summaries", { ok: "{ summaries }" }),
  R("post", `${W}/claims/tier`, "history", "Set a claim's evidence tier", {
    body: SetClaimTierRequest,
    headers: idem,
    ok: "Claim",
  }),
  R("post", `${W}/retention/delete`, "history", "Delete a payload under the retention policy", {
    body: RetentionDeleteRequest,
    headers: idem,
    role: "admin",
    ok: "Deletion record",
  }),
  R("get", `${W}/evidence/:nid`, "provenance", "Evidence node with source provenance and drilldown", {
    capability: "source provenance, drilldown",
    states: S("complete", "stale", "permission_denied"),
    ok: "Evidence node",
  }),
  R("get", `${W}/snapshots`, "snapshots", "List historical snapshots", {
    capability: "historical snapshots",
    ok: "{ snapshots }",
  }),
  R("post", `${W}/snapshots`, "snapshots", "Create a historical snapshot", {
    body: CreateSnapshotRequest,
    headers: idem,
    status: "201",
    ok: "SnapshotSummary",
  }),
  R("get", `${W}/snapshots/compare`, "snapshots", "Diff two snapshots", {
    query: z.object({ a: z.string(), b: z.string() }),
    ok: "SnapshotDiff",
  }),
  R("post", `${W}/snapshots/purge`, "snapshots", "Purge a snapshot payload", {
    body: PurgeSnapshotRequest,
    role: "admin",
    ok: "Purge record",
  }),
  R("get", `${W}/snapshots/:sid`, "snapshots", "Snapshot summary", { ok: "SnapshotSummary" }),
  R("get", `${W}/snapshots/:sid/canvas`, "snapshots", "Canvas as of the snapshot (labelled HISTORICAL)", {
    states: S("complete", "stale"),
    ok: "Canvas document",
  }),
  R("get", `${W}/snapshots/:sid/graph`, "snapshots", "Evidence graph as of the snapshot", {
    ok: "Graph projection",
  }),
  R("get", `${W}/snapshots/:sid/layout`, "snapshots", "Graph layout as of the snapshot", { ok: "Layout" }),
  R("get", `${W}/timeline`, "history", "Workspace timeline", {
    query: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    ok: "{ entries }",
  }),
  R("get", `${W}/revisions/:rev`, "history", "A canvas revision", { ok: "Revision" }),
  R("get", `${W}/revisions/:rev/export`, "history", "Export a canvas revision", { ok: "Export" }),
  R("get", `${W}/branches`, "branches", "List branches", { ok: "{ branches }" }),
  R("post", `${W}/branches`, "branches", "Create a branch", {
    body: CreateBranchRequest,
    headers: idem,
    status: "201",
    ok: "BranchSummary",
  }),
  R("get", `${W}/branches/:bid`, "branches", "Branch detail", { ok: "BranchSummary" }),
  R("get", `${W}/branches/:bid/memory`, "branches", "Branch memory", { ok: "Memory" }),
  R("get", `${W}/branches/:bid/diff`, "branches", "Diff a branch against main", {
    query: z.object({ against: z.string().optional() }),
    ok: "Diff",
  }),
  R("post", `${W}/branches/:bid/changes`, "branches", "Record a change on a branch", {
    body: BranchChangeRequest,
    ok: "Change",
  }),
  R("get", `${W}/merge-proposals`, "branches", "List merge proposals", { ok: "{ proposals }" }),
  R("post", `${W}/merge-proposals`, "branches", "Propose a merge", {
    body: ProposeMergeRequest,
    headers: idem,
    status: "201",
    ok: "MergeProposal",
  }),
  R("get", `${W}/merge-proposals/:pid`, "branches", "Merge proposal detail", { ok: "MergeProposal" }),
  R("post", `${W}/merge-proposals/:pid/resolve`, "branches", "Resolve a merge conflict", {
    body: ResolveConflictRequest,
    ok: "MergeProposal",
  }),
  R("post", `${W}/merge-proposals/:pid/accept`, "branches", "Accept a merge", {
    body: DecideMergeRequest,
    ok: "MergeProposal",
  }),
  R("post", `${W}/merge-proposals/:pid/reject`, "branches", "Reject a merge", {
    body: DecideMergeRequest,
    ok: "MergeProposal",
  }),
  R("get", `${W}/collab/:scope/state`, "collaboration", "Yjs document state (scope: canvas, graph, ...)", {
    ok: "State and cursor",
  }),
  R("post", `${W}/collab/:scope/updates`, "collaboration", "Submit a Yjs update over HTTP", {
    body: CollabUpdateRequest,
    ok: "Ack with cursor",
  }),
  R("get", `${W}/collab/layout/reconcile`, "collaboration", "Reconcile the shared layout with the canvas", {
    ok: "Reconciliation",
  }),
  R("get", `${W}/collab/:scope/presence`, "collaboration", "Presence of other members", { ok: "{ peers }" }),
  R("put", `${W}/collab/:scope/presence`, "collaboration", "Update own presence", {
    query: z.object({ clientId: z.string().optional() }),
    body: CollabPresenceRequest,
    ok: "Peers",
  }),

  // ---- monitoring -------------------------------------------------------------------------------------------------
  R("get", `${W}/markers`, "monitoring", "List markers", {
    capability: "result annotations",
    ok: typed(MarkerListResponse),
  }),
  R("get", `${W}/markers/:mid`, "monitoring", "Marker detail", { ok: "Marker" }),
  R("get", `${W}/markers/:mid/tasks`, "monitoring", "Agent tasks of a marker", {
    capability: "agent task state",
    ok: typed(MarkerTaskListResponse),
  }),
  R("get", `${W}/markers/:mid/delegations`, "monitoring", "Delegations of a marker", {
    ok: "{ delegations }",
  }),
  R("post", `${W}/markers`, "monitoring", "Create a marker (annotation anchored to a selection)", {
    headers: idem,
    status: "201",
    ok: "Marker",
    role: "writer",
  }),
  R("get", `${W}/marker-tasks`, "monitoring", "All marker tasks", {
    capability: "agent task state",
    ok: typed(MarkerTaskListResponse),
  }),
  R("post", `${W}/marker-tasks/dispatch`, "monitoring", "Dispatch open marker tasks", {
    role: "writer",
    ok: "Dispatch summary",
  }),
  R("get", `${W}/lenses`, "monitoring", "List lenses", { ok: typed(LensListResponse) }),
  R("get", `${W}/lenses/:lid/resolution`, "monitoring", "Resolve a lens to its current members", {
    ok: "LensResolution",
  }),
  R("get", `${W}/monitors`, "monitoring", "List monitor rules", {
    capability: "monitoring",
    ok: typed(MonitorRuleListResponse),
  }),
  R("get", `${W}/monitors/triggers`, "monitoring", "Monitor triggers", {
    query: z.object({ ruleId: z.string().optional() }),
    states: S("complete", "insufficient_data"),
    ok: typed(TriggerListResponse),
  }),
  R("get", `${W}/monitors/evaluations`, "monitoring", "Monitor evaluations", {
    query: z.object({ ruleId: z.string().optional() }),
    ok: "{ evaluations }",
  }),
  R("get", `${W}/monitors/export`, "monitoring", "Trigger history export (REPLAY rows labelled)", {
    query: z.object({ format: z.enum(["csv", "json"]).optional() }),
    ok: "{ rows, report } or { csv }",
  }),
  R("get", `${W}/monitors/watermarks`, "monitoring", "Newest watermark per source the rules listen to", {
    states: S("stale", "complete"),
    ok: "{ watermarks }",
  }),
  R("get", `${W}/monitors/counters`, "monitoring", "Trigger counters", { ok: "Counters" }),
  R(
    "post",
    `${W}/monitors/replay`,
    "monitoring",
    "Replay watermark events against the rules (results labelled REPLAY)",
    { role: "writer", ok: "Replay result" },
  ),
  R("get", `${W}/notifications`, "monitoring", "Notifications", {
    query: z.object({ unread: z.enum(["1", "true"]).optional() }),
    ok: typed(NotificationListResponse),
  }),
  R("put", `${W}/delegation-scopes`, "monitoring", "Set what members may delegate to agents", {
    role: "admin",
    ok: "Delegation scope",
  }),

  // ---- capsules and publications ----------------------------------------------------------------------------------
  R("get", "/v1/capsules", "publication", "List capsules visible to the caller", {
    capability: "publications",
    ok: "{ capsules: [{capsuleId,title,label,createdAt}] }",
  }),
  R("get", "/v1/capsules/:id", "publication", "Capsule view with verification state", {
    states: S("complete", "insufficient_data", "method_unvalidated"),
    ok: "{ status: available|unavailable, capsule }",
  }),
  R(
    "post",
    "/v1/capsules/:id/publish",
    "publication",
    "Publish a capsule to the public gateway (explicit; cautionary statuses must be acknowledged)",
    {
      body: AckBody,
      role: "writer",
      states: S("method_unvalidated", "insufficient_data", "permission_denied"),
      ok: "Published; the verification badge and acknowledgements are recorded",
      description:
        "422 ACKNOWLEDGEMENT_REQUIRED lists every cautionary status (INSUFFICIENT_DATA, METHOD_NOT_VALIDATED, NOT_REPRODUCIBLE, VERIFICATION_FAILED, ...) in `details` that must be echoed back in `acknowledge`.",
    },
  ),
  R("post", "/v1/capsules/:id/unpublish", "publication", "Withdraw a publication", {
    role: "writer",
    ok: "Withdrawn",
  }),
  R("get", "/v1/capsules/:id/publication", "publication", "Publication record", {
    ok: "Publication or none",
  }),
  R(
    "get",
    "/v1/capsules/:id/verify",
    "publication",
    "Verify a capsule locally (reproduced / not reproduced)",
    { ok: "Verification report" },
  ),
  R("get", "/v1/capsules/:id/research-run", "publication", "Research run artifact of a capsule", {
    states: S("complete", "insufficient_data", "method_unvalidated"),
    ok: "ResearchRunArtifact",
  }),
  R("get", "/v1/capsules/:id/exports/*", "publication", "A file from the capsule's static exports", {
    ok: { description: "File bytes", contentType: "application/octet-stream" },
  }),
  R(
    "post",
    "/v1/publish",
    "publication",
    "Export the static publication bundle for a capsule (emits research.published); an anchored publication holds anchor gas in USD from the caller's credits (402 CREDITS_EXHAUSTED; 503 PRICE_UNAVAILABLE)",
    {
      body: PublishBody,
      role: "writer",
      states: S("method_unvalidated", "insufficient_data"),
      ok: "Publication bundle summary",
    },
  ),
  R("get", "/v1/integrity/quarantine", "provenance", "Quarantined data integrity findings", {
    ok: "Quarantine list",
  }),
  R("get", "/v1/gateway/runs/:id", "investigation", "Run status for the MCP gateway's own credential", {
    auth: "gateway",
    headers: [
      {
        name: "x-workspace-id",
        description: "Must equal the workspace in the gateway credential.",
        required: true,
      },
    ],
    conditional: "gatewayCredential configured",
    ok: typed(z.strictObject({ id: z.string(), status: z.string(), updatedAt: z.string() })),
  }),

  // ---- spend, budget and SLO -------------------------------------------------------------------------------------
  R("get", `${W}/cost/burn`, "spend", "Workspace spend, cap, per-resource usage and a labelled forecast", {
    capability: "spend and budget status",
    states: S("complete", "budget_exhausted"),
    ok: typed(WorkspaceBurn, "OK", "cost-burn.json"),
  }),
  R("get", `${W}/cost/ledger`, "spend", "Metering entries and blocked spends (usd null = price unknown)", {
    query: z.object({ limit: z.number().int().min(1).max(2000).optional() }),
    ok: typed(LedgerExport, "OK", "cost-ledger.json"),
  }),
  R(
    "get",
    `${W}/cost/reconciliation`,
    "spend",
    "Reservations vs actual charges, stale reservations, unknown prices",
    {
      ok: typed(WorkspaceReconciliation, "OK", "cost-reconciliation.json"),
    },
  ),
  R("put", `${W}/cost/policy`, "spend", "Set the workspace cap and per-resource limits (owner/admin)", {
    body: CostPolicyBody,
    role: "admin",
    ok: typed(CostPolicyRecord),
  }),
  R("post", `${W}/cost/resume`, "spend", "Clear a hard stop (owner/admin)", {
    role: "admin",
    ok: typed(PolicyResumeResponse),
  }),
  R(
    "get",
    "/v1/cost/global",
    "spend",
    "The ONE global USD 5 model-spend ceiling across all workspaces (owner/admin)",
    {
      role: "admin",
      capability: "spend and budget status",
      states: S("complete", "budget_exhausted"),
      ok: typed(GlobalSpendStatus, "OK", "cost-global.json"),
    },
  ),
  R("get", "/v1/cost/global/reconciliation", "spend", "Global model-spend reconciliation (owner/admin)", {
    role: "admin",
    ok: typed(GlobalReconciliation),
  }),
  R("get", "/v1/ops/slo", "spend", "Multi-window burn state of the declared SLOs", { ok: "{ slos }" }),

  // ---- near-real-time layer (opt-in; forward-only final blocks) ----------------------------------------------------
  R("get", "/v1/realtime/freshness", "realtime", "Freshness of the near-real-time NEAR feed", {
    ok: "Last observation/ingestion time, watermark, finality, historical coverage, collector lag, reconciliation, partial-day warnings and data-vintage limitations",
  }),
  R(
    "get",
    "/v1/realtime/transactions-last-hour",
    "realtime",
    "Transactions in the last 60 minutes (finalized and provisional kept apart)",
    {
      ok: "Finalized and provisional transaction counts for the window with missing minutes stated",
    },
  ),

  // ---- entity registry (ecosystem) --------------------------------------------------------------------------------
  R("get", "/v1/entities", "entities", "Search the ecosystem entity registry", {
    capability: "entity registry",
    query: EntityListQ,
    ok: "Entities",
  }),
  R("get", "/v1/entities/registry", "entities", "Registry snapshot and attribution rules", {
    capability: "entity registry",
    ok: "Registry",
  }),
  R("get", "/v1/entities/coverage", "entities", "Classified vs unclassified activity coverage", {
    capability: "historical coverage",
    query: CoverageQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "Coverage",
  }),
  R("get", "/v1/entities/changes", "entities", "Entities with the largest activity change", {
    query: ChangesQ,
    ok: "Changes",
  }),
  R("get", "/v1/entities/:id", "entities", "Entity detail", { ok: "Entity" }),
  R("get", "/v1/entities/:id/mappings", "entities", "Time-versioned contract and account mappings", {
    ok: "Mappings",
  }),
  R("get", "/v1/entities/:id/metrics", "entities", "Entity activity metrics over a date range", {
    query: DayRangeQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "Daily metrics with coverage",
  }),
  R(
    "get",
    "/v1/entities/:id/unique-users",
    "entities",
    "Unique users (CANNOT_COMPUTE when the source cannot support it)",
    { query: DayRangeQ, states: S("insufficient_data", "complete"), ok: "Unique users or CANNOT_COMPUTE" },
  ),

  // ---- analytics panels (contracts 1.8.0): data of panels whose queryRef.resultKind is analytics_result ----------------
  R(
    "get",
    "/v1/analytics/panel/:hash",
    "analytics",
    "Data of an analytics panel: re-executes the stored intents, entities or accounts analysis (labelled ANALYTICS_RESULT, not a certified metric)",
    {
      capability: "intents, entities and accounts analytics",
      states: S("complete", "partial", "insufficient_data", "source_unavailable"),
      ok: typed(
        AnalyticsPanelData,
        "Chart rows, shape, provenance (call, coverage, caveats) and cannotCompute when the source cannot answer",
      ),
    },
  ),

  // ---- Agent tab: quick answers and post-investigation setup ----------------------------------------------------------
  R(
    "post",
    "/v1/assistant/answer",
    "assistant",
    "Quick answer with charts and detailed analysis from typed read-only analytics (no workspace); spends model USD that is charged to the caller's USD credits and counts against the global ceiling",
    {
      description:
        "A planner call picks up to 4 calls from the typed analytics catalogue (intents, entities, accounts), they run in parallel, charts are built from the result tables, and the interpretation stage (analyst and skeptic) writes findings whose every number is tied to a result cell. `summary` is returned only when every number in it grounds against the returned facts, else null. `cannot_answer` carries a reason and what data exists instead. Unknown values are null, never zero. 402 BUDGET_EXCEEDED / CREDITS_EXHAUSTED (details { allowanceUsd, spentUsd, availableUsd, requiredUsd, contactEmail }) when the caller has used their USD credits; 402 BUDGET_EXCEEDED when the one global model-spend ceiling is reached; 429 RATE_LIMITED per user. The actual USD of the turn is charged once to the caller.",
      body: AnswerRequest,
      capability: "agent quick answer",
      states: S(
        "complete",
        "partial",
        "insufficient_data",
        "budget_exhausted",
        "rate_limited",
        "source_unavailable",
      ),
      ok: typed(AnswerResponse, "The answer, its charts, findings, steps, cost and elapsed time"),
    },
  ),
  R(
    "post",
    `${W}/assistant/setup`,
    "assistant",
    "Create markers, monitor rules and one DRAFT hypothesis from a completed run's findings (deterministic, no model spend)",
    {
      description:
        "Reads the COMPLETE run's ready interpretation and creates, as the calling user and through the same kernel commands and hypothesis service as the manual routes: up to 3 DRAFT markers on dated cells a finding cites, up to 3 compare rules on certified daily live metrics with thresholds equal to the cited values, and 1 DRAFT hypothesis. Never freezes, publishes or approves. Idempotent per run (a repeat finds what exists). Whatever cannot be created honestly is listed in `skipped` with the reason. 404 RUN_NOT_IN_WORKSPACE for a run of another workspace; 422 VALIDATION_FAILED (RUN_NOT_COMPLETE, INTERPRETATION_NOT_READY) when the run is not COMPLETE or has no ready interpretation.",
      body: SetupRequest,
      headers: idem,
      role: "writer",
      capability: "agent setup after investigation",
      states: S("complete", "partial", "permission_denied"),
      ok: typed(SetupResponse, "Created markers, monitors and hypothesis, and what was skipped with reasons"),
    },
  ),

  // ---- standalone frontend surface (contracts 1.9.0) ---------------------------------------------------------------------
  R(
    "get",
    `${W}/panels/:hash/data`,
    "frontend",
    "Data of any panel by its query hash: semantic and analytics panels on one route (dispatch on the stored query kind)",
    {
      description:
        "`kind` says which engine answered. Semantic: the guarded gateway with a session bound to the caller (certified or experimental; coverage, gaps, freshness, rollupFreshness, cost). Analytics: the stored capability call re-executed (never a certified metric); `cannotCompute` is HTTP 200 with `chart: null`. `source` (fixture|live) overrides the layer inferred from the stored model hash. 404 QUERY_UNKNOWN when no query is stored under the hash.",
      query: z.object({ source: z.enum(["fixture", "live"]).optional() }),
      capability: "panel data over HTTP",
      states: S(
        "complete",
        "partial",
        "stale",
        "truncated",
        "insufficient_data",
        "source_unavailable",
        "budget_exhausted",
      ),
      ok: typed(
        PanelDataResponse,
        "Chart, shape, provenance, gaps, coverage, freshness, rollupFreshness and cost",
      ),
    },
  ),
  R(
    "post",
    `${W}/canvas/preview`,
    "frontend",
    "Preview a canvas patch: validation plus query cost estimate, no side effects",
    {
      description:
        "Pure: no write, no event, no run, no spend. A rejected patch is 422 PATCH_REJECTED with per-operation issues and lastStableRevision. The estimate lists each query the patch adds or changes (rows, bytes, whether the gateway cache already holds it) and the panels it would leave unservable.",
      body: CanvasPatch,
      capability: "canvas patch preview",
      ok: typed(CanvasPreviewResponse, "Preview hash, base revision, per-operation report and cost estimate"),
    },
  ),
  R(
    "post",
    `${W}/questions/preview`,
    "frontend",
    "Plan a question without starting a run (no model call, no spend)",
    {
      description:
        "Live questions have a deterministic plan (one composer task, then an approval-gated canvas apply), shown exactly. Fixture-source plans come from the director model, so `plan` is null: previewing would cost a model call. `canStart` is false with `blockers` when the caller cannot ask (viewer), the budget is below the minimum, or no engine is configured.",
      body: QuestionPreviewRequest,
      capability: "question plan preview",
      ok: typed(QuestionPreviewResponse, "Plan, budget check and blockers"),
    },
  ),
  R(
    "post",
    `${W}/collab/ticket`,
    "frontend",
    "Single-use, 30-second ticket for the collaboration WebSocket",
    {
      description:
        "Open `/v1/workspaces/:id/collab/{scope}/ws` with the WebSocket subprotocol `nearesis.ticket.<ticket>` instead of a bearer token. The ticket is bound to this workspace (and `scope` when given) and to the caller, and is burned by its first use.",
      body: CollabTicketRequest,
      status: "201",
      capability: "collaboration socket ticket",
      ok: typed(CollabTicketResponse, "Ticket, expiry and the socket path"),
    },
  ),
  R(
    "get",
    "/v1/me",
    "frontend",
    "The caller: principal, organisation, role, workspaces and credits ({ availableUsd, allowanceUsd, exhausted }, additive)",
    {
      capability: "identity",
      ok: typed(MeResponse),
    },
  ),
  R(
    "get",
    "/v1/notifications",
    "frontend",
    "Monitor notifications across the caller's workspaces, newest first",
    {
      query: z.object({
        unread: z.enum(["1", "true", "0", "false"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      capability: "global notifications",
      ok: typed(GlobalNotificationList),
    },
  ),
  R("get", "/v1/approvals", "frontend", "Approvals across the caller's workspaces (pending by default)", {
    query: z.object({ status: z.enum(["pending", "all"]).optional() }),
    capability: "global approvals",
    ok: typed(GlobalApprovalList),
  }),
  R(
    "get",
    "/v1/findings",
    "frontend",
    "Newest interpreted findings (analyst + skeptic) across the caller's workspaces",
    {
      query: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      capability: "global findings",
      ok: "{ findings: { runId, workspaceId, workspaceObjective, question, createdAt, finding: InterpretedFinding }[], truncated, workspaceCount }",
    },
  ),
  R(
    "get",
    "/v1/publications",
    "frontend",
    "Capsules of the caller's organisation with their publication state",
    {
      capability: "publications list",
      ok: typed(PublicationList),
    },
  ),
  R(
    "get",
    "/v1/metrics",
    "frontend",
    "Metric catalogue across the caller's workspaces, with authored statuses",
    {
      capability: "global metric catalogue",
      states: S("complete", "metric_uncertified"),
      ok: typed(GlobalMetricList),
    },
  ),
  R(
    "get",
    "/v1/sources",
    "frontend",
    "Source health: watermark, lag, coverage, recent errors and rate-limit status",
    {
      description:
        "Platform-wide state recorded by ingestion; contains no tenant data. `rateLimit` is null because ingestion does not record provider rate limits. When the health store cannot be read the list is empty and `unavailable` says why (HTTP 200).",
      capability: "source health",
      states: S("complete", "stale", "source_unavailable"),
      ok: typed(GlobalSourceList),
    },
  ),
  R("get", "/v1/auth/oidc/login", "session", "Start an OpenID Connect sign-in (authorization code + PKCE)", {
    auth: "none",
    description:
      "302 to the identity provider, or JSON `{authorizationUrl,state,expiresInSeconds}` with `mode=json` or `Accept: application/json`. 404 OIDC_NOT_CONFIGURED when no issuer is configured.",
    query: z.object({ returnTo: z.string().optional(), mode: z.enum(["redirect", "json"]).optional() }),
    ok: typed(OidcLoginResponse, "Provider URL (mode=json)"),
    conditional: "NEARESIS_OIDC_ISSUER, NEARESIS_OIDC_CLIENT_ID and NEARESIS_OIDC_REDIRECT_URI are set",
  }),
  R(
    "get",
    "/v1/auth/oidc/callback",
    "session",
    "Complete an OpenID Connect sign-in and receive the session token",
    {
      auth: "none",
      description:
        "Called server-to-server by the frontend with the `code` and `state` the provider returned. Returns the same session JWT as dev login. The identity must match an existing user (`users.oidc_subject`); nothing is provisioned.",
      query: z.object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      }),
      ok: typed(OidcCallbackResponse),
      conditional: "NEARESIS_OIDC_ISSUER, NEARESIS_OIDC_CLIENT_ID and NEARESIS_OIDC_REDIRECT_URI are set",
    },
  ),

  // ---- NEAR wallet sign-in (NEP-413, testnet) ---------------------------------------------------------------------
  R(
    "post",
    "/v1/auth/near/challenge",
    "session",
    "Issue a single-use NEP-413 sign-in challenge (5 minutes)",
    {
      auth: "none",
      body: z.strictObject({}),
      ok: typed(
        z.strictObject({
          challengeId: z.uuid(),
          message: z.string(),
          recipient: z.string(),
          nonce: z.string().describe("base64 of 32 random bytes"),
          network: z.literal("testnet"),
          expiresAt: z.string(),
        }),
      ),
    },
  ),
  R("post", "/v1/auth/near/verify", "session", "Verify a NEAR wallet signature and receive a session token", {
    auth: "none",
    description:
      "Fails closed with 401 and reasonCode CHALLENGE_INVALID, SIGNATURE_INVALID, NETWORK_MISMATCH, KEY_NOT_FULL_ACCESS or ACCOUNT_NOT_FOUND. The challenge is burned once presented. A first sign-in provisions the user, a personal organisation and an owner membership.",
    body: NearVerifyBody,
    ok: typed(
      z.strictObject({
        token: z.string(),
        userId: z.uuid(),
        accountId: z.string(),
        created: z.boolean(),
      }),
    ),
  }),
  R("post", "/v1/auth/near/link", "session", "Link a verified NEAR account to the signed-in user", {
    description:
      "409 ACCOUNT_ALREADY_LINKED when another user holds the account, USER_ALREADY_LINKED when this user has a different one.",
    body: NearVerifyBody,
    ok: typed(z.strictObject({ accountId: z.string(), userId: z.uuid() })),
  }),

  // ---- accounts and cohorts (accounts are not people: every response carries meta.caveats) -------------------------
  R(
    "get",
    "/v1/accounts/coverage",
    "accounts",
    "Loaded account-scan window, head threshold and covered days",
    {
      capability: "account scan coverage",
      ok: "Coverage",
    },
  ),
  R("get", "/v1/accounts/daily", "accounts", "Daily active accounts, new vs returning since window start", {
    query: AccountRangeQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "Daily activity with coverage",
  }),
  R(
    "get",
    "/v1/accounts/growth",
    "accounts",
    "Average-DAU change split into new and returning contribution",
    {
      query: AccountGrowthQ,
      states: S("complete", "partial", "insufficient_data"),
      ok: "Growth contribution",
    },
  ),
  R("get", "/v1/accounts/retention", "accounts", "Weekly cohort retention", {
    query: AccountRangeQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "Cohort retention matrix",
  }),
  R("get", "/v1/accounts/concentration", "accounts", "Activity concentration across accounts", {
    query: AccountRangeQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "Concentration",
  }),
  R("get", "/v1/accounts/high-frequency", "accounts", "Highest-frequency accounts", {
    query: AccountHfQ,
    states: S("complete", "partial", "insufficient_data"),
    ok: "High-frequency accounts",
  }),
  R(
    "get",
    "/v1/accounts/:account/profile",
    "accounts",
    "One account's activity profile (404 ACCOUNT_NOT_IN_HEAD_SET)",
    {
      query: AccountRangeQ,
      states: S("complete", "partial", "insufficient_data"),
      ok: "Account profile",
    },
  ),

  // ---- governed metric authoring (drafts, catalogue, lifecycle) ---------------------------------------------------
  ...metricRoutes(),

  // ---- NEAR Intents intelligence (read-only, typed OK / CANNOT_COMPUTE results) ------------------------------------
  ...(
    [
      ["field-inventory", "What the Explorer does and does not identify"],
      ["coverage", "Historical coverage of intents_swaps by UTC day"],
      ["summary", "Swap count, volume and refund summary for a window"],
      ["status", "Swaps by terminal status (optionally per day)"],
      ["assets", "Top origin or destination assets"],
      ["chain-flows", "Origin to destination chain matrix and net flow per chain"],
      ["asset-pairs", "Top asset pairs"],
      ["refund-rates", "Refund and failure rates by chain pair or asset pair"],
      ["refund-causes", "Refunded swaps by the provider refundReason, by reason, week, day or chain pair"],
      ["routes", "Top routes"],
      ["referrals", "Top referrers"],
      ["size-buckets", "Swap size distribution"],
      ["trend", "Trend by day, week or month"],
      ["chain-pair-growth", "Chain-pair growth versus the preceding window"],
      ["concentration", "Concentration (top-N share, HHI) by dimension"],
      ["unusual-flows", "Flows that deviate from their baseline"],
      ["settlement-duration", "Settlement duration; CANNOT_COMPUTE with a labelled indicative alternative"],
      ["solver-metrics", "Solver concentration; CANNOT_COMPUTE (no solver identity in the source)"],
      ["quotes", "Dry-quote intelligence per route (indicative, never executed outcomes)"],
    ] as const
  ).map(([path, summary]) =>
    R("get", `/v1/intents/${path}`, "intents", summary, {
      capability: path === "coverage" ? "historical coverage" : "chart data",
      ...(path === "field-inventory" ? {} : { query: IntentsWin }),
      states: S("complete", "partial", "insufficient_data"),
      ok: typed(IntentsResult, "OK result, or CANNOT_COMPUTE (still HTTP 200; render as insufficient_data)"),
    }),
  ),
];

/** Request headers every route accepts (documented once in docs/api/CHANGELOG-frontend.md). */
export const COMMON_RESPONSE_HEADERS = ["x-trace-id"] as const;

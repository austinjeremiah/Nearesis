import { z } from "zod";
import { Uuid } from "./common.ts";
import { DomainEvent, DomainEventType } from "./events.ts";

/**
 * SSE event catalogue for `GET /v1/workspaces/:id/events` (final_master_prompt s21). The code that writes these frames is
 * `apps/api/src/app.ts` (route `/v1/workspaces/:id/events`); the schemas below are asserted against fixtures and against
 * the real stream in `apps/api/test/sse.test.ts`. Catalogue version 1: a frame name is never reused for another shape.
 */

/** Typed `data` of the domain events the frontend renders progress from. Others carry a free `data` record (see DomainEvent). */
export const PanelStatus = z.enum(["QUERYING", "READY", "ERROR"]);
export const QueryCompletedData = z.looseObject({
  runId: Uuid,
  panelId: Uuid,
  queryHash: z.string().nullable(),
  /** Progressive panels: a panel is QUERYING, then READY or ERROR. `index`/`total` count panels of the approved patch. */
  status: PanelStatus,
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  reasonCode: z.string().optional(),
});
export const RunStateChangedData = z.looseObject({
  runId: Uuid,
  change: z.string().optional(),
  state: z.string().optional(),
});

/** Domain event frames: SSE `event:` is the event type, `id:` is `seq`, `data:` is the whole `DomainEvent`. */
export const SseDomainFrame = DomainEvent;

/** `event: coalesced`. A slow or far-behind client gets ONE aggregate instead of the backlog; `id:` is `toSeq`. */
export const SseCoalescedData = z.strictObject({
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  count: z.number().int().positive(),
  byType: z.record(z.string(), z.number().int().positive()),
  workspaceVersion: z.number().int().nonnegative(),
});

/** `event: reload_required`. The cursor is invalid or older than the retained journal: refetch state, then reconnect with `?cursor=currentSeq`. */
export const SseReloadRequiredData = z.strictObject({
  reason: z.enum(["INVALID_CURSOR", "CURSOR_EXPIRED"]),
  currentSeq: z.number().int().nonnegative(),
  workspaceVersion: z.number().int().nonnegative().nullable(),
});

/** `event: session_expired`. No `id:`. The server then closes the stream; re-authenticate and resume with Last-Event-ID = lastSeq. */
export const SseSessionExpiredData = z.strictObject({
  reason: z.enum(["TOKEN_EXPIRED", "SESSION_REVOKED"]),
  nextAction: z.string(),
  lastSeq: z.number().int().nonnegative(),
});

export interface SseEventSpec {
  event: string;
  /** Key of the schema in `SSE_SCHEMAS`. */
  schema: string;
  hasId: boolean;
  terminal: boolean;
  description: string;
  /** Frontend states (openapi-states.ts) this event moves a view towards. */
  states?: string[];
}

const domain = (
  e: z.infer<typeof DomainEventType>,
  description: string,
  states?: string[],
): SseEventSpec => ({
  event: e,
  schema:
    e === "query.completed"
      ? "SseQueryCompleted"
      : e === "run.state_changed"
        ? "SseRunStateChanged"
        : "SseDomainEvent",
  hasId: true,
  terminal: false,
  description,
  ...(states ? { states } : {}),
});

export const SSE_EVENTS: readonly SseEventSpec[] = [
  domain("workspace.created", "A workspace was created."),
  domain("workspace.updated", "Objective or settings changed; `data` carries the new workspace version."),
  domain("agent.spawned", "A research agent started (investigation progress).", ["loading"]),
  domain("task.started", "An agent task started (investigation progress).", ["loading"]),
  domain("task.completed", "An agent task finished (investigation progress).", ["partial"]),
  domain(
    "query.completed",
    "Progressive panels: one frame per panel status change (QUERYING, READY, ERROR) with index/total.",
    ["loading", "partial", "complete", "source_unavailable"],
  ),
  domain("panel.created", "A panel was added to the canvas."),
  domain("panel.updated", "A panel's spec or data revision changed; refetch its chart data.", ["partial"]),
  domain("panel.removed", "A panel was removed."),
  domain("canvas.patched", "A canvas patch applied atomically; `data` carries operationId and revision."),
  domain("marker.created", "A marker was created."),
  domain("marker.assigned", "A marker was assigned to an agent or user."),
  domain("marker.transitioned", "A marker changed status."),
  domain("marker.evidence_linked", "Evidence was linked to a marker."),
  domain("lens.changed", "A lens was created, updated or deleted."),
  domain("monitor.rule_changed", "A monitor rule was created, updated, enabled or disabled."),
  domain("monitor.triggered", "A monitor rule fired; `data` carries the trigger outcome and data maturity."),
  domain("notification.created", "A notification was created."),
  domain("notification.read", "A notification was marked read."),
  domain("claim.updated", "A claim's tier or support changed."),
  domain("evidence.verified", "An evidence node verification result."),
  domain("snapshot.finalized", "A historical snapshot was finalized."),
  domain("research.published", "A capsule was published (explicit publish, acknowledgements recorded).", [
    "complete",
  ]),
  domain("plugin.installed", "A plugin was installed."),
  domain("plugin.enabled", "A plugin was enabled."),
  domain("plugin.disabled", "A plugin was disabled."),
  domain("plugin.upgraded", "A plugin was upgraded."),
  domain("plugin.rolled_back", "A plugin was rolled back."),
  domain("plugin.quarantined", "A plugin was quarantined."),
  domain("run.state_changed", "Investigation progress: run state or cancel request changed.", [
    "loading",
    "partial",
    "complete",
  ]),
  domain("approval.granted", "An approval was granted."),
  domain("approval.rejected", "An approval was rejected."),
  domain("access.denied", "An access denial was recorded.", ["permission_denied"]),
  domain("graph.layout_saved", "An evidence graph layout was saved."),
  {
    event: "coalesced",
    schema: "SseCoalescedData",
    hasId: true,
    terminal: false,
    description:
      "Backpressure: the client is more than `maxLag` events behind (or slow); one aggregate replaces the backlog. Refetch the views named in byType.",
    states: ["stale"],
  },
  {
    event: "reload_required",
    schema: "SseReloadRequiredData",
    hasId: true,
    terminal: true,
    description:
      "The cursor is invalid or expired. The stream ends. Reload state, then reconnect with cursor=currentSeq.",
    states: ["stale"],
  },
  {
    event: "session_expired",
    schema: "SseSessionExpiredData",
    hasId: false,
    terminal: true,
    description:
      "Token expired or membership revoked. The stream ends. Re-authenticate and resume with Last-Event-ID = lastSeq.",
    states: ["permission_denied"],
  },
];

export const SSE_SCHEMAS = {
  SseDomainEvent: DomainEvent,
  SseQueryCompleted: DomainEvent.extend({ type: z.literal("query.completed"), data: QueryCompletedData }),
  SseRunStateChanged: DomainEvent.extend({ type: z.literal("run.state_changed"), data: RunStateChangedData }),
  SseCoalescedData,
  SseReloadRequiredData,
  SseSessionExpiredData,
} as const;

/** Wire-level semantics, stated once and rendered into docs/api/SSE.md and the OpenAPI `x-sse` extension. */
export const SSE_SEMANTICS = {
  endpoint: "GET /v1/workspaces/{id}/events",
  contentType: "text/event-stream",
  framing:
    "Each frame is `id: <seq>` (domain frames, coalesced, reload_required), `event: <name>`, `data: <single-line JSON>`, blank line. `: ping` comment lines are heartbeats every 15 s of silence and carry no data.",
  ordering: [
    "Domain frames are delivered in strictly increasing `seq` per workspace, each exactly once on a connection.",
    "`seq` is the workspace's committed-journal sequence: a frame is only sent after its transaction committed, so a frame never describes uncommitted state.",
    "A `coalesced` frame replaces the events fromSeq..toSeq; no frame inside that range follows it.",
  ],
  resume: [
    "Send `Last-Event-ID: <last applied seq>` (EventSource does this automatically) or `?cursor=<seq>`; the server replays seq > cursor.",
    "A cursor of 0 (or absent) starts at the beginning of the retained journal.",
    "Clients dedupe by `id`; a replayed frame with seq <= the last applied seq is ignored.",
    "A non-numeric cursor, a cursor beyond the head, or one older than the retained journal yields `reload_required` and the stream ends.",
    "After `session_expired` re-authenticate and resume with the same Last-Event-ID; no events are lost.",
  ],
  limits: [
    "At most 6 concurrent streams per browser (credential + optional `x-client-id` header): the 7th is refused 429 + Retry-After before the stream starts.",
    "A client whose socket stays blocked is coalesced, then disconnected after the drain timeout; it resumes with Last-Event-ID.",
  ],
  authorization:
    "Bearer token; membership is re-validated about every 5 s. A foreign or unknown workspace is the same 404 as a missing one.",
} as const;

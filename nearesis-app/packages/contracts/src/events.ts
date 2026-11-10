import { z } from "zod";
import { IsoDateTime, Sha256Hex, Uuid } from "./common.ts";

export const DomainEventType = z.enum([
  "workspace.created",
  "workspace.updated",
  "agent.spawned",
  "task.started",
  "task.completed",
  "query.completed",
  "panel.created",
  "panel.updated",
  "panel.removed",
  "canvas.patched",
  "marker.created",
  "marker.assigned",
  "claim.updated",
  "evidence.verified",
  "snapshot.finalized",
  "research.published",
  "plugin.installed",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.upgraded",
  "plugin.rolled_back",
  "plugin.quarantined",
  "run.state_changed",
  "approval.granted",
  "approval.rejected",
  "access.denied",
  "graph.layout_saved",
]);
export type DomainEventType = z.infer<typeof DomainEventType>;

/** ch.11 event contract. Minimal data; never secrets, prompts or large frames. */
export const DomainEvent = z.strictObject({
  eventId: Uuid,
  orgId: Uuid,
  workspaceId: Uuid.nullable(),
  seq: z.number().int().positive(),
  type: DomainEventType,
  causationId: z.string().nullable(),
  correlationId: z.string().nullable(),
  actorId: Uuid.nullable(),
  emittedAt: IsoDateTime,
  schemaVersion: z.number().int().positive(),
  payloadHash: Sha256Hex,
  sourceRevision: z.number().int().nonnegative().nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

export const Topic = z.enum([
  "source.watermark.v1",
  "semantic.metric.changed.v1",
  "research.run.state.v1",
  "workspace.entity.changed.v1",
  "monitor.rule.triggered.v1",
  "evidence.verification.result.v1",
  "publication.ready.v1",
]);
export type Topic = z.infer<typeof Topic>;

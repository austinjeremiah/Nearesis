import { z } from 'zod';
import { RunState, SourceHealth } from './enums';

/**
 * SSE event envelopes from Frontend Product Spec v1 section 7.1.
 *
 * Transport rules the client depends on: every event carries a monotonic `seq`
 * so a reconnect can resume with Last-Event-ID, and a stable `eventId` so a
 * redelivery can be deduped. Entity events carry `revision` so an out-of-order
 * delivery can be dropped rather than overwriting newer state.
 */

const Instant = z.string().datetime({ offset: true });

const Base = z.object({
  eventId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  workspaceId: z.string().min(1).nullable(),
  emittedAt: Instant,
});

/** A collector advanced a source watermark. Drives freshness indicators. */
export const SourceWatermarkEvent = Base.extend({
  type: z.literal('source.watermark.v1'),
  sourceId: z.string().min(1),
  watermark: Instant.nullable(),
  health: SourceHealth,
});

/**
 * A certified measure changed definition. Affected panels go STALE and must pass
 * a semantic compatibility check before showing freshly certified results.
 */
export const SemanticMetricChangedEvent = Base.extend({
  type: z.literal('semantic.metric.changed.v1'),
  metricId: z.string().min(1),
  fromVersion: z.string(),
  toVersion: z.string(),
  breaking: z.boolean(),
  affectedPanelIds: z.array(z.string()),
});

export const ResearchRunStateEvent = Base.extend({
  type: z.literal('research.run.state.v1'),
  runId: z.string().min(1),
  state: RunState,
  /** Stage label shown in the run strip, e.g. "Quant". */
  stage: z.string().optional(),
  spentUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
});

/** A durable workspace object changed. `revision` gates the client update. */
export const WorkspaceEntityChangedEvent = Base.extend({
  type: z.literal('workspace.entity.changed.v1'),
  entity: z.enum([
    'panel',
    'marker',
    'monitor',
    'claim',
    'experiment',
    'branch',
    'approval',
    'note',
  ]),
  entityId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  /** Set when the payload is too large to inline; client refetches by id. */
  refetch: z.boolean().default(false),
});

export const MonitorRuleTriggeredEvent = Base.extend({
  type: z.literal('monitor.rule.triggered.v1'),
  ruleId: z.string().min(1),
  markerId: z.string().nullable(),
  /** True when produced by a REPLAY run. Excluded from live counters. */
  replay: z.boolean(),
  breachedAt: Instant,
});

export const EvidenceVerificationResultEvent = Base.extend({
  type: z.literal('evidence.verification.result.v1'),
  capsuleHash: z.string().min(1),
  /**
   * Three distinct claims, never merged into one tick. A local rebuild matching
   * is not an attestation, and an attestation is not proof the source was right.
   */
  reproducible: z.boolean(),
  inputIntegrity: z.boolean(),
  attestation: z.enum(['verified', 'unavailable', 'failed']),
});

export const PublicationReadyEvent = Base.extend({
  type: z.literal('publication.ready.v1'),
  publicationId: z.string().min(1),
  version: z.string().min(1),
});

/**
 * The server lost the ability to serve deltas from the client's cursor. The
 * client reloads the full projection and reconciles unsaved local drafts.
 */
export const ReloadRequiredEvent = Base.extend({
  type: z.literal('reload_required.v1'),
  reason: z.string(),
});

export const WorkspaceEvent = z.discriminatedUnion('type', [
  SourceWatermarkEvent,
  SemanticMetricChangedEvent,
  ResearchRunStateEvent,
  WorkspaceEntityChangedEvent,
  MonitorRuleTriggeredEvent,
  EvidenceVerificationResultEvent,
  PublicationReadyEvent,
  ReloadRequiredEvent,
]);
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>;
export type WorkspaceEventType = WorkspaceEvent['type'];

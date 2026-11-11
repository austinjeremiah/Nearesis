import { z } from "zod";
import { IsoDateTime, Sha256Hex, SemVer, Uuid } from "./common.ts";
import { MarkerAnchor } from "./canvas.ts";
import { AgentRole } from "./agent.ts";

/**
 * v1.5.0 (additive): markers, lenses, monitor rules, notifications and triggers (ch.09 marker state machine,
 * refresh architecture; ch.11 `monitor.rule.triggered.v1`; ch.15 P06).
 */

/** ch.09: DRAFT -> ACTIVE -> INVESTIGATING -> REVIEW_REQUIRED -> RESOLVED | MONITORING | DISMISSED (exactly). */
export const MarkerStatus = z.enum([
  "DRAFT",
  "ACTIVE",
  "INVESTIGATING",
  "REVIEW_REQUIRED",
  "RESOLVED",
  "MONITORING",
  "DISMISSED",
]);
export type MarkerStatus = z.infer<typeof MarkerStatus>;

export const MARKER_TRANSITIONS: Readonly<Record<MarkerStatus, readonly MarkerStatus[]>> = {
  DRAFT: ["ACTIVE"],
  ACTIVE: ["INVESTIGATING"],
  INVESTIGATING: ["REVIEW_REQUIRED"],
  REVIEW_REQUIRED: ["RESOLVED", "MONITORING", "DISMISSED"],
  RESOLVED: [],
  MONITORING: [],
  DISMISSED: [],
};
export const isMarkerTransitionAllowed = (from: MarkerStatus, to: MarkerStatus): boolean =>
  MARKER_TRANSITIONS[from].includes(to);

export const MarkerAnchorType = z.enum(["time_point", "time_range", "threshold", "source_event"]);
export type MarkerAnchorType = z.infer<typeof MarkerAnchorType>;

/** Chart-selection context captured with a marker (ch.09 + C13): enough to re-run the exact query behind the selection. */
export const SelectionContext = z.strictObject({
  queryHash: Sha256Hex,
  semanticVersion: SemVer,
  interval: z.strictObject({ start: IsoDateTime, end: IsoDateTime }),
  seriesIds: z.array(z.string().max(200)).max(32),
  axisUnits: z.record(z.string().max(64), z.string().max(40).nullable()),
  sourceWatermark: IsoDateTime.nullable(),
});
export type SelectionContext = z.infer<typeof SelectionContext>;

/** The full marker record (read model; `status` transitions only through `marker.transition`). */
export const Marker = z.strictObject({
  markerId: Uuid,
  workspaceId: Uuid,
  anchorType: MarkerAnchorType,
  anchor: MarkerAnchor,
  sourcePanelId: Uuid,
  /** Canvas document revision of the source panel when the marker was created. */
  sourceVersion: z.number().int().nonnegative(),
  createdBy: Uuid.nullable(),
  question: z.string().max(4000).nullable(),
  assignedAgents: z.array(AgentRole).max(10),
  linkedEvidenceIds: z.array(Uuid).max(500),
  monitorRuleId: Uuid.nullable(),
  resolution: z.string().max(4000).nullable(),
  timestamp: IsoDateTime,
  status: MarkerStatus,
  version: z.number().int().positive(),
  selection: SelectionContext.nullable(),
});
export type Marker = z.infer<typeof Marker>;

/** Deterministic condition AST (no code, no expressions): evaluated by comparing observed metric values. */
export const CompareOp = z.enum(["gt", "gte", "lt", "lte", "eq", "ne"]);
export type Condition =
  | { kind: "compare"; metricId: string; op: z.infer<typeof CompareOp>; value: number }
  | { kind: "and" | "or"; terms: Condition[] }
  | { kind: "not"; term: Condition };
export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("compare"),
      metricId: z.string().min(1).max(200),
      op: CompareOp,
      value: z.number().finite(),
    }),
    z.strictObject({ kind: z.enum(["and", "or"]), terms: z.array(Condition).min(1).max(8) }),
    z.strictObject({ kind: z.literal("not"), term: Condition }),
  ]),
) as z.ZodType<Condition>;
export const MAX_CONDITION_DEPTH = 4;
export const MAX_CONDITION_NODES = 16;

export const MonitorFrequency = z.strictObject({
  /** Minimum seconds (of source-watermark time) between two evaluations of the rule. */
  minIntervalSeconds: z.number().int().min(0).max(86_400),
});

export const MonitorAction = z.enum(["notify", "investigate"]);

export const MonitorRule = z.strictObject({
  ruleId: Uuid,
  workspaceId: Uuid,
  name: z.string().min(1).max(200),
  markerId: Uuid.nullable(),
  /** Source whose watermark updates drive the rule (e.g. `explorer.swaps`, `bigquery.prices`). */
  sourceId: z.string().min(1).max(200),
  condition: Condition,
  frequency: MonitorFrequency,
  /** The condition must hold continuously for this long (watermark time) before the rule fires. */
  debounceSeconds: z.number().int().min(0).max(86_400),
  /** After firing, further firings inside this window are suppressed (one notification window). */
  cooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400),
  action: MonitorAction,
  enabled: z.boolean(),
  version: z.number().int().positive(),
  createdBy: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type MonitorRule = z.infer<typeof MonitorRule>;

export const TriggerMode = z.enum(["live", "replay"]);
export type TriggerMode = z.infer<typeof TriggerMode>;
export const TriggerOutcome = z.enum([
  "fired",
  "condition_false",
  "debounced",
  "cooldown",
  "frequency",
  "no_data",
  "disabled",
]);
export type TriggerOutcome = z.infer<typeof TriggerOutcome>;

/** One (rule, watermark, mode) evaluation. `mode: replay` is set end to end and never reported as live. */
export const MonitorTrigger = z.strictObject({
  triggerId: Uuid,
  ruleId: Uuid,
  workspaceId: Uuid,
  sourceId: z.string(),
  watermark: IsoDateTime,
  mode: TriggerMode,
  outcome: TriggerOutcome,
  observed: z.record(z.string(), z.number()),
  notificationId: Uuid.nullable(),
  evaluatedAt: IsoDateTime,
});
export type MonitorTrigger = z.infer<typeof MonitorTrigger>;

export const Notification = z.strictObject({
  notificationId: Uuid,
  workspaceId: Uuid,
  ruleId: Uuid,
  triggerId: Uuid,
  markerId: Uuid.nullable(),
  mode: TriggerMode,
  title: z.string().max(300),
  body: z.string().max(2000),
  createdAt: IsoDateTime,
  readAt: IsoDateTime.nullable(),
  readBy: Uuid.nullable(),
});
export type Notification = z.infer<typeof Notification>;

/** A lens anchors one shared filter across a set of panels without mutating their certified metric definitions. */
export const LensFilter = z.strictObject({
  timeRange: z.strictObject({ start: IsoDateTime, end: IsoDateTime }).optional(),
  segment: z
    .strictObject({ dimension: z.string().max(100), values: z.array(z.string().max(200)).max(50) })
    .optional(),
  route: z.string().max(200).optional(),
});
export const Lens = z.strictObject({
  lensId: Uuid,
  workspaceId: Uuid,
  name: z.string().min(1).max(200),
  panelIds: z.array(Uuid).min(1).max(50),
  filter: LensFilter,
  version: z.number().int().positive(),
  createdBy: Uuid.nullable(),
  createdAt: IsoDateTime,
});
export type Lens = z.infer<typeof Lens>;

export const LensResolution = z.strictObject({
  lensId: Uuid,
  panels: z.array(
    z.strictObject({
      panelId: Uuid,
      compatible: z.boolean(),
      reason: z.string().nullable(),
      appliedFilter: LensFilter.nullable(),
    }),
  ),
});
export type LensResolution = z.infer<typeof LensResolution>;

/** Source-watermark update consumed by the monitor scheduler. `values` are the observed metric values at the watermark. */
export const WatermarkEvent = z.strictObject({
  sourceId: z.string().min(1).max(200),
  watermark: IsoDateTime,
  mode: TriggerMode,
  values: z.record(z.string(), z.number().finite()),
});
export type WatermarkEvent = z.infer<typeof WatermarkEvent>;

// ---- command payloads (workspace commands; see api.ts CommandType) ----
export const MarkerCreatePayload = z.strictObject({
  panelId: Uuid,
  markerId: Uuid.optional(),
  anchor: MarkerAnchor,
  question: z.string().max(4000).optional(),
  selection: SelectionContext.optional(),
});
export const MarkerTransitionPayload = z.strictObject({
  markerId: Uuid,
  to: MarkerStatus,
  resolution: z.string().min(1).max(4000).optional(),
});
export const MarkerAssignPayload = z.strictObject({
  markerId: Uuid,
  agents: z.array(AgentRole).min(1).max(10),
  budget: z
    .strictObject({
      tokens: z.number().int().positive(),
      toolCalls: z.number().int().positive(),
      usd: z.number().positive(),
    })
    .optional(),
});
export const MarkerLinkEvidencePayload = z.strictObject({
  markerId: Uuid,
  evidenceIds: z.array(Uuid).min(1).max(50),
});
const RuleBody = {
  name: z.string().min(1).max(200),
  markerId: Uuid.nullable().optional(),
  sourceId: z.string().min(1).max(200),
  condition: Condition,
  frequency: MonitorFrequency.default({ minIntervalSeconds: 0 }),
  debounceSeconds: z.number().int().min(0).max(86_400).default(0),
  cooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 86_400)
    .default(0),
  action: MonitorAction.default("notify"),
};
export const MonitorRuleCreatePayload = z.strictObject({
  ruleId: Uuid.optional(),
  ...RuleBody,
  enabled: z.boolean().default(true),
});
export const MonitorRuleUpdatePayload = z.strictObject({
  ruleId: Uuid,
  name: RuleBody.name.optional(),
  markerId: RuleBody.markerId,
  condition: Condition.optional(),
  frequency: MonitorFrequency.optional(),
  debounceSeconds: RuleBody.debounceSeconds.optional(),
  cooldownSeconds: RuleBody.cooldownSeconds.optional(),
  action: MonitorAction.optional(),
});
export const MonitorRuleTogglePayload = z.strictObject({ ruleId: Uuid });
export const LensCreatePayload = z.strictObject({
  lensId: Uuid.optional(),
  name: z.string().min(1).max(200),
  panelIds: z.array(Uuid).min(1).max(50),
  filter: LensFilter,
});
export const LensUpdatePayload = z.strictObject({
  lensId: Uuid,
  name: z.string().min(1).max(200).optional(),
  panelIds: z.array(Uuid).min(1).max(50).optional(),
  filter: LensFilter.optional(),
});
export const LensDeletePayload = z.strictObject({ lensId: Uuid });
export const NotificationReadPayload = z.strictObject({ notificationId: Uuid });

/** Guards for condition ASTs beyond the schema (depth, node count). */
export function conditionShape(c: Condition): { depth: number; nodes: number } {
  if (c.kind === "compare") return { depth: 1, nodes: 1 };
  const kids = c.kind === "not" ? [c.term] : c.terms;
  const shapes = kids.map(conditionShape);
  return {
    depth: 1 + Math.max(...shapes.map((s) => s.depth)),
    nodes: 1 + shapes.reduce((a, s) => a + s.nodes, 0),
  };
}

// ---- API read models (apps/api; all under /v1/workspaces/{id}) ----
export const MarkerListResponse = z.strictObject({ markers: z.array(Marker) });
export const LensListResponse = z.strictObject({ lenses: z.array(Lens) });
export const MonitorRuleListResponse = z.strictObject({ rules: z.array(MonitorRule) });
export const TriggerListResponse = z.strictObject({ triggers: z.array(MonitorTrigger) });
export const NotificationListResponse = z.strictObject({ notifications: z.array(Notification) });
export const MarkerTask = z.strictObject({
  taskId: Uuid,
  markerId: Uuid,
  runId: Uuid.nullable(),
  workflowId: z.string().nullable(),
  status: z.enum(["PENDING", "RUNNING", "COMPLETE", "FAILED"]),
  origin: z.enum(["assign", "rule"]),
  mode: TriggerMode,
  agents: z.array(AgentRole),
  createdAt: IsoDateTime,
});
export type MarkerTask = z.infer<typeof MarkerTask>;
export const MarkerTaskListResponse = z.strictObject({ tasks: z.array(MarkerTask) });

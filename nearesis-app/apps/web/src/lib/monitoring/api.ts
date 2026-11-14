/**
 * Monitoring client port (P06). The UI depends only on this interface and on `@nearesis/contracts` monitoring types.
 * Two implementations exist: `HttpMonitoringApi` (the kernel via the same-origin BFF, the production path) and
 * `TestMonitoringAdapter` (in-memory, deterministic, selected only by `?monitoring=test-adapter` and labelled in the
 * UI). A test adapter never becomes the production path: `createMonitoringApi` only returns it when explicitly asked.
 */
import type {
  Lens,
  LensResolution,
  Marker,
  MarkerTask,
  MonitorEvaluation,
  MonitorRule,
  MonitorTrigger,
  Notification,
} from "@nearesis/contracts";
import type { z } from "zod";
import type {
  LensCreatePayload,
  LensUpdatePayload,
  MarkerAssignPayload,
  MarkerCreatePayload,
  MarkerLinkEvidencePayload,
  MarkerTransitionPayload,
  MonitorRuleCreatePayload,
  MonitorRuleUpdatePayload,
} from "@nearesis/contracts";

export type Input<T extends z.ZodType> = z.input<T>;

export interface MonitoringSnapshot {
  markers: Marker[];
  lenses: Lens[];
  rules: MonitorRule[];
  triggers: MonitorTrigger[];
  notifications: Notification[];
  tasks: MarkerTask[];
  /** One record per rule evaluation, including skipped_disabled, not_final and suppressed_run_cap. */
  evaluations: MonitorEvaluation[];
  /** Fired triggers today, live and replay counted separately. */
  counters: TriggerCounters;
}

export interface TriggerCounters {
  day: string;
  live: number;
  replay: number;
}

export interface TriggerExportRow {
  triggerId: string;
  ruleId: string;
  sourceId: string;
  watermark: string;
  mode: "live" | "replay";
  outcome: string;
  label: "LIVE" | "REPLAY";
  evaluatedAt: string;
}

/** One link of a marker's delegation chain (user, marker, agents, grants). */
export interface Delegation {
  delegationId: string;
  markerId: string;
  taskId: string;
  userId: string | null;
  agents: string[];
  grants: string[];
  parentDelegationId: string | null;
  depth: number;
}

export interface DelegationScopeInput {
  userId: string;
  agents: string[];
  grants: string[];
  delegateTo: string[];
  maxBudget: { tokens: number; toolCalls: number; usd: number };
}

export type CommandResult<T = unknown> =
  { ok: true; value: T } | { ok: false; status: number; reasonCode: string; message: string };

export interface MonitoringApi {
  /** "kernel" is the real backend; "test-adapter" is shown as a banner so it can never be mistaken for it. */
  readonly kind: "kernel" | "test-adapter";
  /** Reads every list. A rejected promise (or a failed endpoint) is reported, never replaced with empty data. */
  load(): Promise<
    { ok: true; snapshot: MonitoringSnapshot } | { ok: false; status: number; message: string }
  >;
  createMarker(p: Input<typeof MarkerCreatePayload>): Promise<CommandResult>;
  transitionMarker(p: Input<typeof MarkerTransitionPayload>): Promise<CommandResult>;
  assignMarker(p: Input<typeof MarkerAssignPayload>): Promise<CommandResult>;
  linkEvidence(p: Input<typeof MarkerLinkEvidencePayload>): Promise<CommandResult>;
  createLens(p: Input<typeof LensCreatePayload>): Promise<CommandResult>;
  updateLens(p: Input<typeof LensUpdatePayload>): Promise<CommandResult>;
  deleteLens(lensId: string): Promise<CommandResult>;
  resolveLens(lensId: string): Promise<CommandResult<LensResolution>>;
  createRule(p: Input<typeof MonitorRuleCreatePayload>): Promise<CommandResult>;
  updateRule(p: Input<typeof MonitorRuleUpdatePayload>): Promise<CommandResult>;
  setRuleEnabled(ruleId: string, enabled: boolean): Promise<CommandResult>;
  markNotificationRead(notificationId: string): Promise<CommandResult>;
  /** Trigger history export: rows carry their mode and a LIVE/REPLAY label; the report text says REPLAY. */
  exportTriggers(): Promise<CommandResult<{ rows: TriggerExportRow[]; report: string }>>;
  listDelegations(markerId: string): Promise<CommandResult<Delegation[]>>;
  /** Owner/admin only; others get 403 INSUFFICIENT_ROLE from the kernel. */
  setDelegationScope(scope: DelegationScopeInput): Promise<CommandResult>;
}

/** Event types after which the monitoring lists are refetched (contracts events.ts). */
export const MONITORING_EVENTS: ReadonlySet<string> = new Set([
  "marker.created",
  "marker.assigned",
  "marker.transitioned",
  "marker.evidence_linked",
  "lens.changed",
  "monitor.rule_changed",
  "monitor.triggered",
  "notification.created",
  "notification.read",
]);

/** Marker transitions the UI offers; mirrors contracts MARKER_TRANSITIONS (the kernel is the authority). */
export { MARKER_TRANSITIONS, isMarkerTransitionAllowed } from "@nearesis/contracts";

"use client";
import type { Condition, Marker, MarkerStatus, TriggerMode } from "@nearesis/contracts";
import { Badge, StatusDot, type Tone } from "@nearesis/ui";

const STATUS_TONE: Record<MarkerStatus, Tone> = {
  DRAFT: "neutral",
  ACTIVE: "info",
  INVESTIGATING: "info",
  REVIEW_REQUIRED: "warn",
  RESOLVED: "ok",
  MONITORING: "info",
  DISMISSED: "neutral",
};
export const STATUS_LABEL: Record<MarkerStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  INVESTIGATING: "Investigating",
  REVIEW_REQUIRED: "Review required",
  RESOLVED: "Resolved",
  MONITORING: "Monitoring",
  DISMISSED: "Dismissed",
};

/** Static status text: backend state only, no animation and no inferred progress. */
export function MarkerStatusBadge({ status }: { status: MarkerStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]} data-testid="marker-status" data-status={status}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Replay events are never labelled live: the badge text and data attribute both come from `mode`. */
export function ModeBadge({ mode }: { mode: TriggerMode }) {
  return (
    <Badge
      tone={mode === "replay" ? "honesty" : "ok"}
      data-testid={`mode-badge-${mode}`}
      data-mode={mode}
      title={mode === "replay" ? "Recorded history replayed; not a live observation" : "Live source data"}
    >
      {mode === "replay" ? "REPLAY" : "LIVE"}
    </Badge>
  );
}

export function SourceDot({ freshness }: { freshness: string | undefined }) {
  const tone: Tone =
    freshness === "fresh"
      ? "ok"
      : freshness === undefined
        ? "neutral"
        : freshness === "unavailable"
          ? "bad"
          : "warn";
  return <StatusDot tone={tone} />;
}

export function describeAnchor(a: Marker["anchor"]): string {
  switch (a.kind) {
    case "time_point":
      return `Point at ${a.at}`;
    case "time_range":
      return `Range ${a.start} to ${a.end}`;
    case "threshold":
      return `Threshold ${a.metricId} ${a.op === "gt" ? ">" : "<"} ${a.value}`;
    case "source_event":
      return `Source event ${a.sourceId} / ${a.eventId} at ${a.at}`;
  }
}

const OP: Record<string, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", ne: "!=" };
export function describeCondition(c: Condition): string {
  if (c.kind === "compare") return `${c.metricId} ${OP[c.op]} ${c.value}`;
  if (c.kind === "zscore") return `|z(${c.metricId}, ${c.windowDays} d)| > ${c.absoluteGt}`;
  if (c.kind === "not") return `not (${describeCondition(c.term)})`;
  return c.terms.map((t) => `(${describeCondition(t)})`).join(c.kind === "and" ? " and " : " or ");
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function fmtSeconds(s: number): string {
  if (s === 0) return "none";
  if (s % 86400 === 0) return `${s / 86400} d`;
  if (s % 3600 === 0) return `${s / 3600} h`;
  if (s % 60 === 0) return `${s / 60} min`;
  return `${s} s`;
}

/** Plain-language meaning of the reason codes the kernel returns; unknown codes are shown verbatim, never hidden. */
const REASONS: Record<string, string> = {
  DELEGATION_SCOPE_REQUIRED:
    "You have no delegation scope in this workspace, so you cannot assign agents. Ask an owner or admin to grant one (Delegation tab); owners and admins hold an implicit scope.",
  INSUFFICIENT_ROLE: "Your role does not allow this. Only owners and admins grant delegation scopes.",
  MARKER_NOT_ACTIVE: "Agents can only be assigned to an Active marker.",
  WORKFLOW_START_FAILED:
    "The investigation run could not be started. The marker keeps its state; nothing ran.",
  BUDGET_EXCEEDED: "The investigation stopped because it reached its budget.",
  UNGROUNDED_NUMBER: "The investigation was stopped because it produced a number not backed by evidence.",
  SOURCE_UNAVAILABLE: "A required source was unavailable, so the investigation could not finish.",
};
export function explainReason(code: string | null | undefined): string | null {
  if (!code) return null;
  return REASONS[code] ?? null;
}

/** What each evaluation status means (shown beside it so a skipped evaluation is never mistaken for "false"). */
export const EVAL_STATUS: Record<string, { label: string; why: string }> = {
  fired: { label: "Fired", why: "The condition held and a trigger was recorded." },
  condition_false: { label: "Condition false", why: "The metric did not meet the condition." },
  debounced: { label: "Debounced", why: "The condition has not held long enough yet." },
  cooldown: { label: "In cooldown", why: "The rule fired recently; cooldown suppresses repeats." },
  frequency: { label: "Skipped (frequency)", why: "Evaluated less than the minimum interval ago." },
  no_data: { label: "No data", why: "The watermark carried no value for the metric." },
  not_final: {
    label: "Skipped (not final)",
    why: "The watermark is provisional and the rule is finalized_only, so it was recorded but not evaluated.",
  },
  suppressed_run_cap: {
    label: "Suppressed (run cap)",
    why: "The rule reached maxRunsPerDay for this UTC day; the trigger is kept but no agent task was started.",
  },
  skipped_disabled: {
    label: "Skipped (rule disabled)",
    why: "The rule was disabled when this watermark arrived; recorded, not evaluated.",
  },
};

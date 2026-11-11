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

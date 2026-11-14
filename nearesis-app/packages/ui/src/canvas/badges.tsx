import type { ReactNode } from "react";
import { IconShield } from "../icons";
import { Badge, StatusDot, type Tone } from "../primitives";
import type { Certification, Completeness, Freshness, PanelState, SourceLabel } from "../types";

const FRESH_TONE: Record<Freshness, Tone> = {
  fresh: "ok",
  late: "warn",
  partial: "warn",
  stale: "warn",
  unavailable: "bad",
};

/** Source freshness. Text is always present (never colour alone). `age` is a pre-formatted string such as "3m ago". */
export function FreshnessBadge({
  freshness,
  age,
  ...rest
}: {
  freshness: Freshness;
  age?: string;
  "data-testid"?: string;
}) {
  return (
    <Badge tone={FRESH_TONE[freshness]} {...rest}>
      <StatusDot tone={FRESH_TONE[freshness]} />
      {freshness}
      {age ? <span className="nz-badge-sub">{age}</span> : null}
    </Badge>
  );
}

const COMPLETE_TONE: Record<Completeness, Tone> = { complete: "ok", partial: "warn", unavailable: "bad" };
export function CompletenessBadge({
  completeness,
  ...rest
}: {
  completeness: Completeness;
  "data-testid"?: string;
}) {
  return (
    <Badge tone={COMPLETE_TONE[completeness]} {...rest}>
      {completeness}
    </Badge>
  );
}

const STATE_TONE: Record<PanelState, Tone> = {
  DRAFT: "neutral",
  VALIDATING: "info",
  QUERYING: "info",
  READY: "ok",
  STALE: "warn",
  REFRESHING: "info",
  ERROR: "bad",
  ARCHIVED: "neutral",
};
export function PanelStateBadge({ state, ...rest }: { state: PanelState; "data-testid"?: string }) {
  const busy = state === "REFRESHING" || state === "QUERYING" || state === "VALIDATING";
  // A healthy panel does not need a pill: the state stays in the DOM and on screen as quiet text.
  if (state === "READY")
    return (
      <span className="nz-state-quiet" {...rest}>
        <StatusDot tone="ok" />
        {state}
      </span>
    );
  return (
    <Badge tone={STATE_TONE[state]} {...rest}>
      <StatusDot tone={STATE_TONE[state]} pulse={busy} />
      {state}
    </Badge>
  );
}

const CERT_LABEL: Record<Certification, string> = {
  certified: "certified",
  experimental: "unattested",
  partial: "partial",
  stale: "stale",
};

/**
 * Honesty label. SYNTHETIC and unattested data always carry this dashed, hatched tag: it is never collapsed into a
 * menu and never styled like a status. Non-honesty sources render as a quiet chip that toggles the provenance inspector.
 */
export function ProvenanceChip({
  sourceLabel,
  certification,
  expanded,
  onToggle,
  children,
  ...rest
}: {
  sourceLabel: SourceLabel;
  certification?: Certification;
  expanded?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const honesty = sourceLabel === "SYNTHETIC" || certification === "experimental";
  const body = (
    <>
      {honesty ? null : <IconShield width={12} height={12} />}
      {sourceLabel}
      {certification ? <span className="nz-badge-sub">{CERT_LABEL[certification]}</span> : null}
      {children}
    </>
  );
  if (honesty)
    return (
      <Badge tone="honesty" data-source={sourceLabel} {...rest}>
        {body}
      </Badge>
    );
  return onToggle ? (
    <button type="button" className="nz-chip" aria-expanded={expanded} onClick={onToggle} {...rest}>
      {body}
    </button>
  ) : (
    <span className="nz-chip" {...rest}>
      {body}
    </span>
  );
}

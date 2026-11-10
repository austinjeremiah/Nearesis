import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ProvenanceChip } from "../canvas/badges";
import { IconBranch, IconCheck, IconLink, IconQuery, IconShield, IconWarn } from "../icons";
import { motionTokens, useReducedMotion } from "../motion";
import { Badge, Button, StatusDot, type Tone } from "../primitives";
import type { ApprovalView, Citation, RunState, RunTaskView, TimelineEvent } from "../types";

export const RUN_STATE_LABEL: Record<RunState, string> = {
  REQUESTED: "Requested",
  PLANNING: "Planning",
  APPROVAL_NEEDED: "Needs your approval",
  EXECUTING: "Running",
  EVIDENCE_REVIEW: "Reviewing evidence",
  CANVAS_PATCH_REVIEW: "Preparing panels",
  COMPLETE: "Complete",
  PARTIAL: "Partial result",
  BLOCKED: "Blocked",
  CANCELLED: "Cancelled",
};
export const RUN_STATE_TONE: Record<RunState, Tone> = {
  REQUESTED: "info",
  PLANNING: "info",
  APPROVAL_NEEDED: "warn",
  EXECUTING: "info",
  EVIDENCE_REVIEW: "info",
  CANVAS_PATCH_REVIEW: "info",
  COMPLETE: "ok",
  PARTIAL: "warn",
  BLOCKED: "bad",
  CANCELLED: "neutral",
};

const ROLE_LABEL: Record<string, string> = {
  director: "Director",
  semantic_analyst: "Semantic analyst",
  data_scout: "Data scout",
  quant: "Quant",
  skeptic: "Skeptic",
  economics: "Economics",
  composer: "Composer",
  monitoring: "Monitoring",
  auditor: "Auditor",
  publisher: "Publisher",
};
export const roleLabel = (r: string) => ROLE_LABEL[r] ?? r;

const TASK_TONE: Record<RunTaskView["status"], Tone> = {
  QUEUED: "neutral",
  RUNNING: "info",
  WAITING_APPROVAL: "warn",
  DONE: "ok",
  FAILED: "bad",
  CANCELLED: "neutral",
};

function Mark({ tone, pulse, children }: { tone: Tone; pulse?: boolean; children?: React.ReactNode }) {
  return (
    <span className="nz-tl-mark" style={{ color: `var(--${tone === "neutral" ? "fg-subtle" : tone})` }}>
      {children ?? <StatusDot tone={tone} pulse={pulse} />}
    </span>
  );
}

/**
 * Live run log. Rows arrive in order from SSE (run.state_changed, agent.spawned, task.*, query.completed); each plays a
 * 200 ms enter, and nothing already shown moves. Child agents indent under their parent.
 */
export function RunTimeline({ events, running }: { events: TimelineEvent[]; running: boolean }) {
  const last = events.length - 1;
  return (
    <ol className="nz-timeline" aria-label="Run progress">
      {events.map((e, i) => {
        const live = running && i === last;
        const nested = e.kind === "agent" && e.parentTaskId !== null;
        const body = (() => {
          switch (e.kind) {
            case "state":
              return {
                // Only the current (or final) state carries colour; earlier states recede to grey.
                mark: <Mark tone={live || i === last ? RUN_STATE_TONE[e.state] : "neutral"} pulse={live} />,
                title: RUN_STATE_LABEL[e.state],
                sub: e.note,
              };
            case "agent":
              return {
                mark: (
                  <Mark tone={TASK_TONE[e.status]} pulse={live && e.status === "RUNNING"}>
                    <IconBranch />
                  </Mark>
                ),
                title: roleLabel(e.role),
                sub: e.objective ?? undefined,
              };
            case "query":
              return {
                mark: (
                  <Mark tone="neutral">
                    <IconQuery />
                  </Mark>
                ),
                title: `Query ${e.metric}`,
                sub: `${e.rows === null ? "rows pending" : `${e.rows.toLocaleString("en-US")} rows`} · ${e.queryHash.slice(0, 10)}`,
                chip: <ProvenanceChip sourceLabel="LIVE" certification={e.certification} />,
              };
            case "abstention":
              return {
                mark: (
                  <Mark tone="warn">
                    <IconWarn />
                  </Mark>
                ),
                title: `Cannot compute ${e.metric}`,
                sub: e.reason,
              };
            case "approval":
              return {
                mark: (
                  <Mark tone="warn">
                    <IconShield />
                  </Mark>
                ),
                title: "Waiting for your approval",
                sub: undefined,
              };
            case "panel":
              return {
                mark: (
                  <Mark tone="ok">
                    <IconCheck />
                  </Mark>
                ),
                title: e.added ? `Added panel ${e.title}` : `Proposed panel ${e.title}`,
                sub: `query ${e.queryHash.slice(0, 10)}`,
              };
          }
        })();
        return (
          <li
            key={e.id}
            className="nz-tl-item nz-tl-enter"
            style={nested ? { marginLeft: 16 } : undefined}
            data-kind={e.kind}
          >
            {body.mark}
            <div className="nz-tl-body">
              <div className="nz-tl-title">
                <span>{body.title}</span>
                {"chip" in body ? body.chip : null}
              </div>
              {body.sub ? <div className="nz-tl-sub">{body.sub}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Approval request bound to the action hash. The decision callback receives the exact hash shown here, which the API
 * requires and re-verifies; a mismatch is rejected server-side (ACTION_HASH_MISMATCH).
 */
export function ApprovalCard({
  approval,
  onDecide,
  busy,
}: {
  approval: ApprovalView;
  onDecide: (a: ApprovalView, d: "approve" | "reject") => void;
  busy?: boolean;
}) {
  const reduced = useReducedMotion();
  const pending = approval.status === "pending";
  return (
    <AnimatePresence initial={false}>
      <motion.div
        className="nz-card"
        data-tone={pending ? "warn" : "muted"}
        data-testid="approval-card"
        data-approval-status={approval.status}
        initial={reduced ? false : { opacity: 0, y: 6, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0 } : motionTokens.spring}
        role={pending ? "group" : undefined}
        aria-label="Approval request"
      >
        <div className="nz-card-title">
          <IconShield />
          <span>
            {pending
              ? "Approval needed"
              : approval.status === "approved"
                ? "Approved"
                : approval.status === "rejected"
                  ? "Rejected"
                  : "Superseded"}
          </span>
          {approval.status !== "pending" ? (
            <Badge
              tone={
                approval.status === "approved" ? "ok" : approval.status === "rejected" ? "bad" : "neutral"
              }
            >
              {approval.status}
            </Badge>
          ) : null}
        </div>
        <dl className="nz-kv">
          <dt>Action</dt>
          <dd>{approval.kind ?? "unspecified"}</dd>
          <dt>Network</dt>
          <dd>{approval.network ?? "none"}</dd>
          <dt>Cost limit</dt>
          <dd className="nz-tabular">
            {approval.costLimit === null ? "none" : `$${approval.costLimit.toFixed(2)}`}
          </dd>
          <dt>Action hash</dt>
          <dd className="nz-hash" data-testid="approval-hash">
            {approval.actionHash}
          </dd>
        </dl>
        {pending ? (
          <>
            <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-xs)" }}>
              Approving authorises exactly this action. If the plan changes, the hash changes and this request
              is replaced.
            </p>
            <div className="nz-card-actions">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => onDecide(approval, "reject")}
                data-testid="approval-reject"
              >
                Reject
              </Button>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => onDecide(approval, "approve")}
                data-testid="approval-approve"
              >
                Approve action
              </Button>
            </div>
          </>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}

/** "Cannot compute" is a first-class result, not an error: it names the metric and why, and keeps the run honest. */
export function AbstentionCard({ metric, reason, next }: { metric: string; reason: string; next?: string }) {
  return (
    <div className="nz-card" data-tone="muted" data-testid="abstention-card">
      <div className="nz-card-title">
        <IconWarn />
        <span>Cannot compute {metric}</span>
      </div>
      <div style={{ color: "var(--fg-muted)" }}>{reason}</div>
      {next ? <div style={{ fontSize: "var(--text-xs)" }}>{next}</div> : null}
    </div>
  );
}

export function CitationChip({ citation, onOpen }: { citation: Citation; onOpen?: (c: Citation) => void }) {
  return (
    <button
      type="button"
      className="nz-chip"
      onClick={() => onOpen?.(citation)}
      title={`query ${citation.queryHash}`}
      data-testid="citation-chip"
    >
      <IconLink width={12} height={12} />
      {citation.label}
      <span className="nz-mono">{citation.queryHash.slice(0, 7)}</span>
    </button>
  );
}

/** Panels the composer proposes: nothing lands on the canvas until the user adds it. */
export function ProposedPanels({
  panels,
  onAdd,
}: {
  panels: Array<{ panelId: string; title: string; added: boolean }>;
  onAdd: (panelId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!panels.length) return null;
  return (
    <div className="nz-card" data-testid="proposed-panels">
      <div className="nz-card-title">Panels from this run</div>
      {panels.map((p) => (
        <div key={p.panelId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="nz-grow">{p.title}</span>
          {p.added ? (
            <Badge tone="ok">
              <IconCheck width={12} height={12} /> on canvas
            </Badge>
          ) : (
            <Button
              size="sm"
              disabled={busy === p.panelId}
              onClick={() => {
                setBusy(p.panelId);
                onAdd(p.panelId);
                setTimeout(() => setBusy(null), 600);
              }}
            >
              Add to canvas
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

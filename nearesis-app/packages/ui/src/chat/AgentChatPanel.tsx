import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IconSend, IconStop, IconX } from "../icons";
import { Badge, Button, IconButton, Meter, StatusDot } from "../primitives";
import type {
  ApprovalView,
  BudgetView,
  Citation,
  RunFinding,
  RunView,
  ThreadItem,
  TimelineEvent,
} from "../types";
import { TERMINAL_RUN_STATES } from "../types";
import {
  AbstentionCard,
  ApprovalCard,
  CitationChip,
  ProposedPanels,
  RUN_STATE_LABEL,
  RUN_STATE_TONE,
  RunTimeline,
} from "./parts";

/** Everything the panel needs to draw one run. The app builds it from GET /v1/runs/:id, the approvals route and SSE events. */
export interface RunCardModel {
  run: RunView;
  events: TimelineEvent[];
  approvals: ApprovalView[];
  budget?: BudgetView;
  /** Final summary as it streams; `summaryDone` removes the caret. */
  summary?: string;
  summaryDone?: boolean;
  citations?: Citation[];
  panels?: Array<{ panelId: string; title: string; added: boolean }>;
}

export interface AgentChatPanelProps {
  thread: ThreadItem[];
  runs: Record<string, RunCardModel>;
  /** POST /v1/workspaces/:id/questions. The app supplies idempotency key and budget. */
  onSubmit: (question: string) => void | Promise<void>;
  /** POST /v1/runs/:id/cancel */
  onCancel: (runId: string) => void;
  /** POST /v1/runs/:id/approvals/:approvalId with { decision, actionHash } */
  onDecide: (runId: string, approval: ApprovalView, decision: "approve" | "reject") => void;
  onAddToCanvas: (runId: string, panelId: string) => void;
  onOpenCitation?: (c: Citation) => void;
  onClose?: () => void;
  error?: string | null;
  /** Shown in the composer footer, for example "60k tokens · 16 calls · $1.00". */
  budgetNote?: string;
  headerExtra?: ReactNode;
}

function BudgetRow({ budget }: { budget: BudgetView }) {
  const rows: Array<[string, BudgetView["tokens"], (n: number) => string]> = [
    ["Tokens", budget.tokens, (n) => n.toLocaleString("en-US")],
    ["Tool calls", budget.toolCalls, (n) => String(n)],
    ["Cost", budget.usd, (n) => `$${n.toFixed(2)}`],
  ];
  return (
    <div
      style={{ display: "grid", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--border)" }}
      data-testid="run-budget"
    >
      {rows.map(([label, v, f]) => (
        <div
          key={label}
          style={{
            display: "grid",
            gridTemplateColumns: "72px 1fr auto",
            alignItems: "center",
            gap: 8,
            fontSize: "var(--text-xs)",
            color: "var(--fg-muted)",
          }}
        >
          <span>{label}</span>
          {v.used === null ? <span /> : <Meter value={v.used} max={v.total} label={`${label} used`} />}
          <span className="nz-tabular">
            {v.used === null ? `of ${f(v.total)}` : `${f(v.used)} / ${f(v.total)}`}
          </span>
        </div>
      ))}
    </div>
  );
}

const FINDING_STATUS: Record<
  RunFinding["status"],
  { label: string; tone: "ok" | "warn" | "bad" | "neutral" }
> = {
  supported: { label: "Supported", tone: "ok" },
  mixed: { label: "Mixed", tone: "warn" },
  insufficient_data: { label: "Insufficient data", tone: "warn" },
  cannot_compute: { label: "Cannot compute", tone: "warn" },
  contradicted: { label: "Contradicted", tone: "bad" },
  unverified: { label: "Unverified", tone: "neutral" },
};

/** What the run's panels show: grounded findings, labelled observation or inference, with limitations and skeptic notes. */
function Findings({
  run,
  citations,
  onOpen,
}: {
  run: RunView;
  citations: Citation[] | undefined;
  onOpen: ((c: Citation) => void) | undefined;
}) {
  const findings = run.findings ?? [];
  if (!findings.length) {
    return run.interpretation?.state === "unavailable" ? (
      <div className="nz-card" data-tone="warn" data-testid="findings-unavailable">
        Interpretation unavailable ({run.interpretation.reason ?? "unknown reason"}). The panels are
        unaffected.
      </div>
    ) : null;
  }
  return (
    <div style={{ display: "grid", gap: 8 }} data-testid="findings">
      {findings.map((f) => {
        const st = FINDING_STATUS[f.status] ?? FINDING_STATUS.unverified;
        const sources = (citations ?? []).filter((c) => f.panelIds.includes(c.id));
        return (
          <div
            key={f.id}
            className="nz-card"
            data-testid="finding"
            data-basis={f.basis}
            data-status={f.status}
          >
            <div className="nz-card-title">
              <span>{f.basis === "observation" ? "Observation" : "Inference"}</span>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <div style={{ lineHeight: "var(--lh-loose)", maxWidth: "62ch" }}>{f.statement}</div>
            {sources.length ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                {sources.map((c) => (
                  <CitationChip key={c.id} citation={c} {...(onOpen ? { onOpen } : {})} />
                ))}
              </div>
            ) : null}
            {f.limitations.length ? (
              <details>
                <summary>Limitations ({f.limitations.length})</summary>
                <ul>
                  {f.limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            {f.skepticNotes.length ? (
              <details>
                <summary>Skeptic notes ({f.skepticNotes.length})</summary>
                <ul>
                  {f.skepticNotes.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function RunCard({ m, props }: { m: RunCardModel; props: AgentChatPanelProps }) {
  const { run } = m;
  const running = !TERMINAL_RUN_STATES.includes(run.state);
  const pending = m.approvals.filter((a) => a.status === "pending");
  const history = m.approvals.filter((a) => a.status !== "pending");
  const abst = m.events.filter(
    (e): e is Extract<TimelineEvent, { kind: "abstention" }> => e.kind === "abstention",
  );
  return (
    <article className="nz-run" data-testid="run-card" data-run-id={run.runId} data-run-state={run.state}>
      <header className="nz-run-head">
        <StatusDot tone={RUN_STATE_TONE[run.state]} pulse={running && run.state !== "APPROVAL_NEEDED"} />
        <b data-testid="run-status" data-run-state={run.state}>
          {RUN_STATE_LABEL[run.state]}
        </b>
        <span className="nz-sb-meta nz-mono">{run.runId.slice(0, 8)}</span>
        <span className="nz-grow" />
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => props.onCancel(run.runId)}
            aria-label={`Cancel run ${run.runId.slice(0, 8)}`}
          >
            <IconStop /> Cancel
          </Button>
        ) : null}
      </header>
      <RunTimeline events={m.events.filter((e) => e.kind !== "abstention")} running={running} />
      <div style={{ display: "grid", gap: 8, padding: "0 12px 12px" }}>
        {abst.map((a) => (
          <AbstentionCard
            key={a.id}
            metric={a.metric}
            reason={a.reason}
            next="The run stopped spawning branches for this metric. Other results below are unaffected."
          />
        ))}
        {pending.map((a) => (
          <ApprovalCard
            key={a.approvalId}
            approval={a}
            onDecide={(ap, d) => props.onDecide(run.runId, ap, d)}
          />
        ))}
        {run.failure ? (
          <div className="nz-card" data-tone="bad" role="alert" data-testid="run-failure">
            <div className="nz-card-title">
              <span>Run {run.state === "BLOCKED" ? "blocked" : "failed"}</span>
              <Badge tone="bad">{run.failure.reasonCode}</Badge>
            </div>
            {run.failure.humanActionNeeded ? <div>{run.failure.humanActionNeeded}</div> : null}
            <div className="nz-hash">Replay: {run.failure.replayCommand}</div>
          </div>
        ) : null}
        {m.summary ? (
          <div
            data-testid="run-summary"
            className={m.summaryDone ? undefined : "nz-caret"}
            style={{ lineHeight: "var(--lh-loose)", maxWidth: "62ch" }}
            aria-live="polite"
          >
            {m.summary}
          </div>
        ) : null}
        <Findings run={run} citations={m.citations} onOpen={props.onOpenCitation} />
        {m.citations?.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }} aria-label="Sources for this answer">
            {m.citations.map((c) => (
              <CitationChip key={c.id} citation={c} onOpen={props.onOpenCitation} />
            ))}
          </div>
        ) : null}
        {m.panels ? (
          <ProposedPanels panels={m.panels} onAdd={(id) => props.onAddToCanvas(run.runId, id)} />
        ) : null}
        {history.map((a) => (
          <ApprovalCard key={a.approvalId} approval={a} onDecide={() => undefined} />
        ))}
      </div>
      {m.budget ? <BudgetRow budget={m.budget} /> : null}
    </article>
  );
}

export function AgentChatPanel(props: AgentChatPanelProps) {
  const { thread, runs, onSubmit, error, budgetNote } = props;
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const active = Object.values(runs).some((r) => !TERMINAL_RUN_STATES.includes(r.run.state));

  const signature =
    thread.length +
    Object.values(runs).reduce(
      (n, r) => n + r.events.length + (r.summary?.length ?? 0) + r.approvals.length,
      0,
    );
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [signature]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || active) return;
    setText("");
    stick.current = true;
    void onSubmit(q);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit();
  };

  return (
    <section className="nz-chat" aria-label="Agent chat">
      <div className="nz-chat-head">
        <h2>Ask</h2>
        {props.headerExtra}
        {props.onClose ? (
          <IconButton label="Close agent panel" onClick={props.onClose}>
            <IconX />
          </IconButton>
        ) : null}
      </div>
      <div
        className="nz-chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        role="log"
        aria-live="off"
        aria-label="Conversation"
      >
        {thread.length === 0 ? (
          <div className="nz-state" style={{ height: "auto", padding: 0 }}>
            <strong>Ask a research question</strong>
            <div>
              The agent plans, runs semantic queries and shows every step. You approve anything that costs
              money or leaves the workspace.
            </div>
          </div>
        ) : null}
        {thread.map((t) =>
          t.role === "user" ? (
            <div key={t.id} className="nz-msg-user" data-testid="user-message">
              {t.text}
            </div>
          ) : t.runId && runs[t.runId] ? (
            <RunCard key={t.id} m={runs[t.runId] as RunCardModel} props={props} />
          ) : null,
        )}
      </div>
      <form className="nz-composer" onSubmit={submit}>
        {error ? (
          <p
            role="alert"
            data-testid="ask-error"
            style={{ color: "var(--bad)", fontSize: "var(--text-xs)", marginBottom: 8 }}
          >
            {error}
          </p>
        ) : null}
        <div className="nz-composer-box">
          <textarea
            data-testid="ask-input"
            aria-label="Ask a research question"
            placeholder="Ask a question about NEAR Intents"
            rows={2}
            maxLength={4000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="nz-composer-foot">
            <span className="nz-grow">{budgetNote ?? "Enter to send, Shift+Enter for a new line"}</span>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              data-testid="ask-submit"
              disabled={!text.trim() || active}
            >
              <IconSend /> Ask
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
}

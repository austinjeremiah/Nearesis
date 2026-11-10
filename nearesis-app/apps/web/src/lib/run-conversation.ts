"use client";
import type { DomainEvent, RunBudgetUsage, RunListItem } from "@nearesis/contracts";
import type {
  ApprovalView,
  BudgetView,
  Citation,
  RunCardModel,
  RunState,
  RunView,
  ThreadItem,
  TimelineEvent,
} from "@nearesis/ui";
import { TERMINAL_RUN_STATES } from "@nearesis/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hooks } from "./test-hooks.ts";
import type { SourceLabel } from "./types.ts";

/** GET /v1/runs/:id as served by the BFF (RunView plus the budget usage added in contracts 1.3.0). */
type ApiRun = RunView & { budget?: RunBudgetUsage };

const POLL_MS = 1000;
const BUDGET = { tokens: 60000, toolCalls: 16, usd: 1 };
export const BUDGET_NOTE = "60k tokens · 16 calls · $1.00 per question";

const isTerminal = (s: RunState) => TERMINAL_RUN_STATES.includes(s);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function budgetView(b: RunBudgetUsage | undefined): BudgetView | undefined {
  if (!b) return undefined;
  return {
    tokens: { used: b.spent.tokens, total: b.total.tokens },
    toolCalls: { used: b.spent.toolCalls, total: b.total.toolCalls },
    usd: { used: b.spent.usd, total: b.total.usd },
  };
}

function stubRun(runId: string, workspaceId: string, state: RunState = "REQUESTED"): RunView {
  return {
    runId,
    workspaceId,
    state,
    terminal: isTerminal(state),
    version: 0,
    failure: null,
    result: null,
    rootTask: null,
    children: [],
    evidenceLinks: [],
  };
}

/** Appends or replaces by id so a re-poll never duplicates a row. */
function upsert(events: TimelineEvent[], e: TimelineEvent): TimelineEvent[] {
  const i = events.findIndex((x) => x.id === e.id);
  if (i < 0) return [...events, e];
  const next = events.slice();
  next[i] = e;
  return next;
}

export interface RunConversation {
  thread: ThreadItem[];
  runs: Record<string, RunCardModel>;
  error: string | null;
  submit: (question: string) => Promise<void>;
  cancel: (runId: string) => void;
  decide: (runId: string, approval: ApprovalView, decision: "approve" | "reject") => void;
  /** Loads an earlier run (sidebar click) into the conversation. */
  openRun: (runId: string, summary?: string) => void;
  /** SSE events from the workspace stream; only those carrying a tracked runId are used. */
  ingestEvent: (e: DomainEvent) => void;
  /** Panels that appeared on the canvas while a run was active (completion path: canvas.patched then reload). */
  notePanels: (
    panels: Array<{ panelId: string; title: string; queryHash: string; sourceLabel: SourceLabel }>,
  ) => void;
  investigations: RunListItem[];
  activeRun: RunCardModel | null;
}

/**
 * Store hook behind AgentChatPanel. Same requests as the original ask box: POST questions (Idempotency-Key, live
 * snapshot, fixed budget), 1 s poll of GET /runs/:id, approvals list when approval is needed, decisions with the exact
 * actionHash, cancel with the run version. The kernel API is only reached through the same-origin BFF (/api/k).
 */
export function useRunConversation(workspaceId: string, enabled: boolean): RunConversation {
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [runs, setRuns] = useState<Record<string, RunCardModel>>({});
  const [error, setError] = useState<string | null>(null);
  const [investigations, setInvestigations] = useState<RunListItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const mounted = useRef(true);
  const historic = useRef(new Set<string>());
  const doneAt = useRef(new Map<string, number>());

  const patch = useCallback((runId: string, f: (m: RunCardModel) => RunCardModel) => {
    setRuns((cur) => {
      const m = cur[runId];
      return m ? { ...cur, [runId]: f(m) } : cur;
    });
  }, []);

  const loadList = useCallback(async () => {
    const r = await fetch(`/api/k/workspaces/${workspaceId}/runs`, { cache: "no-store" }).catch(() => null);
    if (!r?.ok || !mounted.current) return;
    const b = (await r.json()) as { runs?: RunListItem[] };
    setInvestigations(b.runs ?? []);
  }, [workspaceId]);

  const loadApprovals = useCallback(
    async (runId: string) => {
      const r = await fetch(`/api/k/runs/${runId}/approvals?status=all`, { cache: "no-store" }).catch(
        () => null,
      );
      if (!r?.ok) return;
      const b = (await r.json()) as { approvals: ApprovalView[] };
      patch(runId, (m) => ({ ...m, approvals: b.approvals }));
    },
    [patch],
  );

  const poll = useCallback(
    async (runId: string) => {
      const r = await fetch(`/api/k/runs/${runId}`, { cache: "no-store" }).catch(() => null);
      if (!r?.ok || !mounted.current) return;
      const v = (await r.json()) as ApiRun;
      const now = new Date().toISOString();
      patch(runId, (m) => {
        let events = m.events;
        if (m.run.state !== v.state || !events.some((e) => e.kind === "state"))
          events = upsert(events, {
            id: `state-${runId}-${v.state}`,
            kind: "state",
            at: now,
            state: v.state,
          });
        const tasks = [...(v.rootTask ? [v.rootTask] : []), ...v.children];
        for (const t of tasks)
          events = upsert(events, {
            id: `agent-${t.taskId}`,
            kind: "agent",
            at: events.find((e) => e.id === `agent-${t.taskId}`)?.at ?? now,
            role: t.role,
            objective: t.objective,
            taskId: t.taskId,
            parentTaskId: t.parentTaskId,
            status: t.status,
          });
        const budget = budgetView(v.budget);
        return { ...m, run: v, events, ...(budget ? { budget } : {}) };
      });
      hooks().run = { runId, state: v.state, terminal: v.terminal };
      if (v.state === "APPROVAL_NEEDED" || v.terminal) void loadApprovals(runId);
      if (v.terminal) {
        if (!doneAt.current.has(runId)) doneAt.current.set(runId, Date.now());
        const t = timers.current.get(runId);
        if (t) clearInterval(t);
        timers.current.delete(runId);
        void loadList();
      }
    },
    [patch, loadApprovals, loadList],
  );

  const follow = useCallback(
    (runId: string) => {
      if (timers.current.has(runId)) return;
      void poll(runId);
      timers.current.set(
        runId,
        setInterval(() => void poll(runId), POLL_MS),
      );
    },
    [poll],
  );

  useEffect(() => {
    mounted.current = true;
    const t = timers.current;
    if (enabled) void loadList();
    return () => {
      mounted.current = false;
      for (const x of t.values()) clearInterval(x);
      t.clear();
    };
  }, [enabled, loadList]);

  const submit = useCallback(
    async (question: string) => {
      setError(null);
      const r = await fetch(`/api/k/workspaces/${workspaceId}/questions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ question, snapshotPolicy: "live", budget: BUDGET }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string; reasonCode?: string };
        setError(`${r.status} ${b.reasonCode ?? ""} ${b.message ?? ""}`.trim());
        return;
      }
      const { runId } = (await r.json()) as { runId: string };
      const at = new Date().toISOString();
      setThread((t) => [
        ...t,
        { id: `u-${runId}`, role: "user", text: question, at },
        { id: `r-${runId}`, role: "run", runId, at },
      ]);
      setRuns((cur) => ({
        ...cur,
        [runId]: {
          run: stubRun(runId, workspaceId),
          events: [{ id: `state-${runId}-REQUESTED`, kind: "state", at, state: "REQUESTED" }],
          approvals: [],
        },
      }));
      hooks().run = { runId, state: "REQUESTED", terminal: false };
      follow(runId);
      void loadList();
    },
    [workspaceId, follow, loadList],
  );

  const cancel = useCallback(
    (runId: string) => {
      void (async () => {
        const post = async (version: number) =>
          fetch(`/api/k/runs/${runId}/cancel`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ expectedVersion: version }),
          });
        const current = async () => {
          const g = await fetch(`/api/k/runs/${runId}`, { cache: "no-store" });
          return g.ok ? ((await g.json()) as ApiRun).version : null;
        };
        let version = runsRef.current[runId]?.run.version ?? (await current());
        if (version === null) return;
        let r = await post(version);
        if (r.status === 409) {
          version = await current();
          if (version !== null) r = await post(version);
        }
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { message?: string; reasonCode?: string };
          setError(`${r.status} ${b.reasonCode ?? ""} ${b.message ?? ""}`.trim());
        }
        follow(runId);
        void poll(runId);
      })();
    },
    [follow, poll],
  );

  const decide = useCallback(
    (runId: string, approval: ApprovalView, decision: "approve" | "reject") => {
      void (async () => {
        setError(null);
        const r = await fetch(`/api/k/runs/${runId}/approvals/${approval.approvalId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision, actionHash: approval.actionHash }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => ({}))) as { message?: string; reasonCode?: string };
          setError(`${r.status} ${b.reasonCode ?? ""} ${b.message ?? ""}`.trim());
        }
        follow(runId);
        await loadApprovals(runId);
        void poll(runId);
      })();
    },
    [follow, loadApprovals, poll],
  );

  const openRun = useCallback(
    (runId: string, summary?: string) => {
      if (runsRef.current[runId]) return;
      historic.current.add(runId);
      const at = new Date().toISOString();
      setThread((t) => [
        ...t,
        ...(summary ? [{ id: `u-${runId}`, role: "user" as const, text: summary, at }] : []),
        { id: `r-${runId}`, role: "run" as const, runId, at },
      ]);
      setRuns((cur) => ({
        ...cur,
        [runId]: { run: stubRun(runId, workspaceId), events: [], approvals: [] },
      }));
      follow(runId);
    },
    [follow, workspaceId],
  );

  const ingestEvent = useCallback(
    (e: DomainEvent) => {
      const d = e.data;
      const runId = str(d.runId);
      if (!runId || !runsRef.current[runId]) return;
      const at = e.emittedAt;
      const id = `ev-${e.eventId}`;
      if (e.type === "query.completed") {
        patch(runId, (m) => ({
          ...m,
          events: upsert(m.events, {
            id,
            kind: "query",
            at,
            taskId: str(d.taskId),
            metric: str(d.metric) ?? "query",
            queryHash: str(d.queryHash) ?? "",
            rows: typeof d.rows === "number" ? d.rows : null,
            certification: (["certified", "experimental", "partial", "stale"].includes(
              str(d.certification) ?? "",
            )
              ? str(d.certification)
              : "experimental") as "certified" | "experimental" | "partial" | "stale",
          }),
        }));
      } else if (e.type === "approval.granted" || e.type === "approval.rejected") {
        patch(runId, (m) => ({
          ...m,
          events: upsert(m.events, { id, kind: "approval", at, approvalId: str(d.approvalId) ?? "" }),
        }));
      }
      // Every run-scoped event is a cue to re-read the run now instead of waiting for the next tick.
      void poll(runId);
    },
    [patch, poll],
  );

  const notePanels = useCallback<RunConversation["notePanels"]>(
    (panels) => {
      // The run that is active, or that finished moments ago (canvas.patched can land after the terminal poll).
      const active = Object.entries(runsRef.current).filter(
        ([id, m]) => !isTerminal(m.run.state) || Date.now() - (doneAt.current.get(id) ?? 0) < 20000,
      );
      const target = active[active.length - 1]?.[0];
      if (!target || !panels.length) return;
      const at = new Date().toISOString();
      patch(target, (m) => {
        let events = m.events;
        for (const p of panels)
          events = upsert(events, {
            id: `panel-${p.panelId}`,
            kind: "panel",
            at,
            panelId: p.panelId,
            title: p.title,
            queryHash: p.queryHash,
            added: true,
          });
        const citations: Citation[] = [
          ...(m.citations ?? []),
          ...panels
            .filter((p) => p.queryHash)
            .map((p) => ({
              id: p.panelId,
              label: p.title,
              queryHash: p.queryHash,
              sourceLabel: p.sourceLabel,
            })),
        ];
        return {
          ...m,
          events,
          citations,
          panels: [
            ...(m.panels ?? []),
            ...panels.map((p) => ({ panelId: p.panelId, title: p.title, added: true })),
          ],
        };
      });
    },
    [patch],
  );

  // Completion summary: states what happened on the canvas; never invents findings.
  const viewRuns = useMemo(() => {
    const out: Record<string, RunCardModel> = {};
    for (const [runId, m] of Object.entries(runs)) {
      if (!isTerminal(m.run.state)) {
        out[runId] = m;
        continue;
      }
      const n = m.panels?.length ?? 0;
      const summary =
        m.run.state === "COMPLETE"
          ? historic.current.has(runId) && !n
            ? "Earlier run. Its panels, if any, are on the canvas with their provenance."
            : n
              ? `Added ${n} panel${n === 1 ? "" : "s"} to the canvas. Each keeps its query and provenance.`
              : "The run completed. No new panels were added to the canvas."
          : m.run.state === "CANCELLED"
            ? "The run was cancelled. Nothing further was applied."
            : m.run.state === "PARTIAL"
              ? "The run finished with partial results. Check each panel's completeness label."
              : undefined;
      out[runId] = { ...m, ...(summary ? { summary } : {}), summaryDone: true };
    }
    return out;
  }, [runs]);

  const lastRunId = [...thread].reverse().find((t) => t.runId)?.runId;
  return {
    thread,
    runs: viewRuns,
    error,
    submit,
    cancel,
    decide,
    openRun,
    ingestEvent,
    notePanels,
    investigations,
    activeRun: lastRunId ? (viewRuns[lastRunId] ?? null) : null,
  };
}

import type { ApprovalView, ThreadItem, RunCardModel, RunView } from "@nearesis/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTION_HASH,
  APPROVAL_PENDING,
  EVENTS,
  QUESTION,
  RUN_ID,
  SUMMARY,
  seed,
  type SeedName,
} from "./fixtures/run";

/**
 * Mocked run stream. Reveals the scripted events on a timer (the lab stands in for SSE), pauses at the approval, and
 * streams the summary token by token. `speed` scales every delay (tests use a high value).
 */
export function useMockRun(initial: SeedName, speed = 1) {
  const [state, setState] = useState(() => seed(initial));
  const timers = useRef<number[]>([]);
  const clear = () => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  };
  useEffect(() => clear, []);

  const patch = useCallback((fn: (m: RunCardModel) => RunCardModel) => {
    setState((s) => {
      const m = s.runs[RUN_ID];
      return m ? { ...s, runs: { ...s.runs, [RUN_ID]: fn(m) } } : s;
    });
  }, []);

  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms / speed));
  };

  const reveal = useCallback(
    (from: number, to: number, gap = 700) => {
      for (let i = from; i < to; i++)
        later((i - from + 1) * gap, () =>
          patch((m) => {
            const ev = EVENTS[i]!;
            const run: RunView = ev.kind === "state" ? { ...m.run, state: ev.state } : m.run;
            const approvals: ApprovalView[] = ev.kind === "approval" ? [APPROVAL_PENDING] : m.approvals;
            const state = ev.kind === "approval" ? "APPROVAL_NEEDED" : run.state;
            return {
              ...m,
              run: {
                ...run,
                state,
                terminal: ["COMPLETE", "PARTIAL", "BLOCKED", "CANCELLED"].includes(state),
              },
              events: EVENTS.slice(0, i + 1),
              approvals,
              budget: m.budget && {
                tokens: { used: 4000 + i * 3800, total: 60000 },
                toolCalls: { used: Math.min(16, 1 + i), total: 16 },
                usd: { used: +(0.03 + i * 0.04).toFixed(2), total: 1 },
              },
            };
          }),
        );
    },
    [patch],
  );

  const stream = useCallback(() => {
    const words = SUMMARY.split(" ");
    words.forEach((_, k) =>
      later((k + 1) * 45, () =>
        patch((m) => ({
          ...m,
          summary: words.slice(0, k + 1).join(" "),
          summaryDone: k === words.length - 1,
          ...(k === words.length - 1
            ? {
                citations: [
                  {
                    id: "c1",
                    label: "Fill rate by chain",
                    queryHash: "b41d0c7e92aa5f31",
                    sourceLabel: "LIVE" as const,
                  },
                  {
                    id: "c2",
                    label: "Settled volume",
                    queryHash: "e07a31bb5c8d64f2",
                    sourceLabel: "LIVE" as const,
                  },
                ],
                panels: [
                  { panelId: "p-fill", title: "Fill rate by chain", added: false },
                  { panelId: "p-vol", title: "Settled volume, Solana", added: false },
                ],
              }
            : {}),
        })),
      ),
    );
  }, [patch]);

  const submit = useCallback(
    (question: string) => {
      clear();
      const thread: ThreadItem[] = [
        { id: `u-${Date.now()}`, role: "user", text: question || QUESTION, at: new Date().toISOString() },
        { id: `r-${Date.now()}`, role: "run", runId: RUN_ID, at: new Date().toISOString() },
      ];
      setState({
        thread,
        runs: {
          [RUN_ID]: {
            run: {
              runId: RUN_ID,
              workspaceId: "w",
              state: "REQUESTED",
              terminal: false,
              version: 1,
              failure: null,
              result: null,
              rootTask: null,
              children: [],
              evidenceLinks: [],
            },
            events: EVENTS.slice(0, 1),
            approvals: [],
            budget: {
              tokens: { used: 0, total: 60000 },
              toolCalls: { used: 0, total: 16 },
              usd: { used: 0, total: 1 },
            },
          },
        },
      });
      reveal(1, 8); // up to the approval request
    },
    [reveal],
  );

  const decide = useCallback(
    (_runId: string, a: ApprovalView, d: "approve" | "reject") => {
      if (a.actionHash !== ACTION_HASH) return;
      patch((m) => ({
        ...m,
        approvals: m.approvals.map((x) =>
          x.approvalId === a.approvalId
            ? {
                ...x,
                status: d === "approve" ? "approved" : "rejected",
                decidedBy: "you",
                decidedAt: new Date().toISOString(),
              }
            : x,
        ),
      }));
      if (d === "reject") {
        patch((m) => ({ ...m, run: { ...m.run, state: "BLOCKED", terminal: true } }));
        return;
      }
      reveal(8, 14, 650);
      later(14 * 650 + 400, stream);
    },
    [patch, reveal, stream],
  );

  const cancel = useCallback(() => {
    clear();
    patch((m) => ({ ...m, run: { ...m.run, state: "CANCELLED", terminal: true } }));
  }, [patch]);

  const addToCanvas = useCallback(
    (_r: string, panelId: string) =>
      patch((m) => ({
        ...m,
        panels: m.panels?.map((p) => (p.panelId === panelId ? { ...p, added: true } : p)),
      })),
    [patch],
  );

  return {
    ...state,
    submit,
    decide,
    cancel,
    addToCanvas,
    reset: (s: SeedName) => {
      clear();
      setState(seed(s));
    },
  };
}

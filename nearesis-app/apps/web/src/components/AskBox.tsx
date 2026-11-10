"use client";
import { useEffect, useRef, useState } from "react";
import { hooks } from "../lib/test-hooks.ts";

interface RunView {
  runId: string;
  state: string;
  terminal: boolean;
}

/**
 * Natural-language request box (ch.09 "Prompt -> canvas"). It only submits the question to the kernel API's
 * investigation route and follows the run; panels arrive as committed canvas patches over the event stream.
 */
export function AskBox({ workspaceId }: { workspaceId: string }) {
  const [text, setText] = useState("");
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const follow = (runId: string) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const r = await fetch(`/api/k/runs/${runId}`, { cache: "no-store" }).catch(() => null);
      if (!r?.ok) return;
      const v = (await r.json()) as { state: string; terminal: boolean };
      setRun({ runId, state: v.state, terminal: v.terminal });
      hooks().run = { runId, state: v.state, terminal: v.terminal };
      if (v.terminal && timer.current) clearInterval(timer.current);
    }, 1000);
  };

  const submit = async () => {
    const question = text.trim();
    if (!question) return;
    setError(null);
    const r = await fetch(`/api/k/workspaces/${workspaceId}/questions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        question,
        snapshotPolicy: "live",
        budget: { tokens: 60000, toolCalls: 16, usd: 1 },
      }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { message?: string; reasonCode?: string };
      setError(`${r.status} ${b.reasonCode ?? ""} ${b.message ?? ""}`.trim());
      return;
    }
    const { runId } = (await r.json()) as { runId: string };
    setRun({ runId, state: "REQUESTED", terminal: false });
    hooks().run = { runId, state: "REQUESTED", terminal: false };
    follow(runId);
  };

  return (
    <form
      className="ask"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <input
        aria-label="Ask a research question"
        data-testid="ask-input"
        placeholder="Ask a question about NEAR Intents…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={4000}
      />
      <button type="submit" data-testid="ask-submit" disabled={!text.trim() || (!!run && !run.terminal)}>
        Ask
      </button>
      {run && (
        <span className="badge" role="status" data-testid="run-status" data-run-state={run.state}>
          run {run.state}
        </span>
      )}
      {error && (
        <span className="badge ERROR" role="alert" data-testid="ask-error">
          {error}
        </span>
      )}
    </form>
  );
}

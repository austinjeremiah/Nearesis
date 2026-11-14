/* eslint-disable @typescript-eslint/no-explicit-any, no-empty, no-useless-assignment, @typescript-eslint/no-unused-vars */
/**
 * Time breakdown of ONE question run (final_master_prompt s15). Works against any API (HTTP or in-process inject) through
 * `BreakdownIo`. Reports request -> first progress event, request -> approval request, approval -> first applied panel,
 * approval -> terminal, request -> findings durable, per-activity time (Temporal history; scheduled -> closed, since Temporal
 * stamps ActivityTaskStarted at completion) and each gateway tool call (tool_invocations started/completed). Changes nothing.
 */
import type pg from "pg";
import type { Client } from "@temporalio/client";

export interface BreakdownIo {
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: any }>;
  /** pool that can read runtime.run_events and public.tool_invocations (RLS is satisfied through set_config below) */
  pool: pg.Pool;
  temporal: Client;
  workspaceId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (a: number | null, b: number | null) => (a == null || b == null ? null : Math.round(b - a));
const ts = (t: any): number => Number(t?.seconds ?? 0) * 1000 + Number(t?.nanos ?? 0) / 1e6;

export async function measureQuestion(io: BreakdownIo, question: string, timeoutMs = 240_000) {
  const t0 = Date.now();
  const sub = await io.call(
    "POST",
    `/v1/workspaces/${io.workspaceId}/questions`,
    { question, snapshotPolicy: "live", source: "live", budget: { tokens: 200000, toolCalls: 24, usd: 3 } },
    { "idempotency-key": `lat-${t0}-${Math.random().toString(36).slice(2, 12)}` },
  );
  const tAck = Date.now();
  if (sub.status !== 202) return { question, error: `submit ${sub.status} ${JSON.stringify(sub.json)}` };
  const { runId, workflowId } = sub.json as { runId: string; workflowId: string };
  let tApprovalSeen: number | null = null,
    tApproved: number | null = null,
    tDone: number | null = null;
  let state = "";
  for (;;) {
    const v = (await io.call("GET", `/v1/runs/${runId}`)).json ?? {};
    state = v.state;
    if (state === "APPROVAL_NEEDED" && !tApproved) {
      tApprovalSeen = Date.now();
      const a = ((await io.call("GET", `/v1/runs/${runId}/approvals`)).json.approvals as any[])?.[0];
      if (a) {
        tApproved = Date.now();
        await io.call("POST", `/v1/runs/${runId}/approvals/${a.approvalId}`, {
          decision: "approve",
          actionHash: a.actionHash,
        });
      }
    }
    if (v.terminal) {
      tDone = Date.now();
      break;
    }
    if (Date.now() - t0 > timeoutMs) break;
    await sleep(200);
  }
  const ev = (
    await io.pool.query(
      "SELECT kind, to_state, detail, created_at FROM runtime.run_events WHERE run_id=$1 ORDER BY id",
      [runId],
    )
  ).rows.map((r) => ({ kind: r.kind, to: r.to_state, at: r.created_at.getTime(), detail: r.detail }));
  const evAt = (pred: (e: any) => boolean) => ev.find(pred)?.at ?? null;
  const tenant = (
    await io.pool.query("SELECT tenant_id FROM runtime.run_events WHERE run_id=$1 LIMIT 1", [runId])
  ).rows[0]?.tenant_id;
  const tools: any[] = [];
  const firstPanel: { at: number | null } = { at: null };
  {
    const c = await io.pool.connect();
    try {
      await c.query(
        "SELECT set_config('app.org_id',$1,false), set_config('app.actor_kind','service',false)",
        [tenant],
      );
      const r = await c.query(
        "SELECT capability, started_at, completed_at, state FROM tool_invocations WHERE workspace_id=$1 AND started_at >= $2 ORDER BY started_at",
        [io.workspaceId, new Date(t0 - 500)],
      );
      for (const x of r.rows)
        tools.push({
          capability: x.capability,
          startMs: Math.round(x.started_at.getTime() - t0),
          durMs: x.completed_at ? Math.round(x.completed_at.getTime() - x.started_at.getTime()) : null,
          state: x.state,
        });
      const p = await c
        .query("SELECT min(created_at) AS t FROM canvas_patches WHERE workspace_id=$1 AND created_at >= $2", [
          io.workspaceId,
          new Date(t0 - 500),
        ])
        .catch(() => ({ rows: [] as any[] }));
      firstPanel.at = p.rows[0]?.t ? p.rows[0].t.getTime() : null;
    } finally {
      c.release();
    }
  }
  const acts: any[] = [];
  const collect = async (wid: string, label: string) => {
    const h = await io.temporal.workflow.getHandle(wid).fetchHistory();
    const sched = new Map<number, any>();
    for (const e of h.events ?? []) {
      const id = Number(e.eventId);
      const t = ts(e.eventTime);
      if (e.activityTaskScheduledEventAttributes)
        sched.set(id, { name: e.activityTaskScheduledEventAttributes.activityType?.name, t });
      else if (
        e.activityTaskCompletedEventAttributes ||
        e.activityTaskFailedEventAttributes ||
        e.activityTaskCanceledEventAttributes
      ) {
        const a = (e.activityTaskCompletedEventAttributes ??
          e.activityTaskFailedEventAttributes ??
          e.activityTaskCanceledEventAttributes) as any;
        const s = sched.get(Number(a.scheduledEventId));
        if (s)
          acts.push({
            wf: label,
            name: s.name,
            schedAt: s.t,
            totalMs: Math.round(t - s.t),
            failed: !!e.activityTaskFailedEventAttributes,
          });
      }
    }
    return (h.events ?? []).flatMap((e) =>
      e.childWorkflowExecutionStartedEventAttributes?.workflowExecution?.workflowId
        ? [e.childWorkflowExecutionStartedEventAttributes.workflowExecution.workflowId]
        : [],
    );
  };
  for (const k of await collect(workflowId, "run")) await collect(k, "child").catch(() => []);
  acts.sort((a, b) => a.schedAt - b.schedAt);
  const findings = (await io.call("GET", `/v1/runs/${runId}`)).json?.findings as unknown[] | undefined;
  const interpFinished = evAt((e) => e.kind === "interpretation.finished");
  const firstDiscoverDone = tools.find((t) => t.capability === "semantic.discover@1");
  const firstWork = tools.find((t) => t.capability !== "semantic.discover@1");
  return {
    question,
    runId,
    finalState: state,
    findings: findings?.length ?? null,
    requestToFirstProgressMs: ms(
      t0,
      evAt((e) => e.kind === "run.requested"),
    ),
    planningMs: ms(
      evAt((e) => e.to === "PLANNING"),
      evAt((e) => e.to === "EXECUTING"),
    ),
    requestToApprovalMs: ms(t0, tApprovalSeen),
    composerModelMs:
      firstDiscoverDone && firstWork
        ? firstWork.startMs - (firstDiscoverDone.startMs + (firstDiscoverDone.durMs ?? 0))
        : null,
    composerToolsMs: firstWork && tApprovalSeen ? Math.round(tApprovalSeen - t0 - firstWork.startMs) : null,
    approvalToFirstPanelMs: firstPanel.at && tApproved ? Math.round(firstPanel.at - tApproved) : null,
    approvalToCompleteMs: ms(tApproved, tDone),
    findingsDurableAfterRequestMs: interpFinished == null ? null : Math.round(interpFinished - t0),
    requestToCompleteMs: ms(t0, tDone),
    activities: acts.map(({ schedAt, ...a }) => ({ ...a, startMs: Math.round(schedAt - t0) })),
    tools,
    events: ev.map((e) => ({
      kind: e.kind,
      to: e.to,
      tPlusMs: Math.round(e.at - t0),
      ...(e.kind === "interpretation.finished" ? { detail: e.detail } : {}),
    })),
  };
}

export function printRun(row: any): void {
  const { activities, tools, events, ...head } = row;
  console.log(JSON.stringify(head));
  for (const a of (activities ?? []).filter((x: any) => x.totalMs > 150))
    console.log(
      `   act  ${String(a.name).padEnd(24)} +${String(a.startMs).padStart(6)} ms  ${String(a.totalMs).padStart(6)} ms${a.failed ? "  FAILED" : ""}`,
    );
  for (const a of tools ?? [])
    console.log(
      `   tool ${String(a.capability).padEnd(24)} +${String(a.startMs).padStart(6)} ms  ${String(a.durMs).padStart(6)} ms ${a.state}`,
    );
  for (const e of (events ?? []).filter(
    (x: any) => x.to || /approval|interpretation|privileged|canvas/.test(x.kind),
  ))
    console.log(
      `   ev   +${String(e.tPlusMs).padStart(6)} ms ${e.to ?? e.kind}${e.detail ? ` ${JSON.stringify(e.detail)}` : ""}`,
    );
}

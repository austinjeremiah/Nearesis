import { createHash, randomUUID } from "node:crypto";
import type { Marker, TriggerMode } from "@nearesis/contracts";
import { sessionForUser } from "../auth.ts";
import type { Session } from "../auth.ts";
import type { CommandBus } from "../commands.ts";
import type { Db } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { writeAudit } from "../journal.ts";
import { MARKER_TASK_DEFAULT_BUDGET } from "./commands.ts";

export interface RunOutput {
  taskId: string;
  role?: string;
  outputRef: string;
}
/** Why a run did not succeed, as the runtime reports it (for example `UNGROUNDED_NUMBER`, `SOURCE_UNAVAILABLE`). */
export type RunFailure = { reasonCode: string };
/** The investigation runtime as the marker task service sees it. The API implements it over RunsService + Temporal. */
export interface RunPort {
  start(
    session: Session,
    workspaceId: string,
    input: {
      question: string;
      budget: { tokens: number; toolCalls: number; usd: number };
      idempotencyKey: string;
      mode: TriggerMode;
      /** Capabilities the child may use (subset of the assigner's delegation scope). Recorded for audit. */
      grants: string[];
    },
  ): Promise<{ runId: string; workflowId: string }>;
  status(
    session: Session,
    runId: string,
  ): Promise<{
    state: string;
    terminal: boolean;
    succeeded: boolean;
    outputs: RunOutput[];
    failure?: RunFailure | null;
  } | null>;
}

interface TaskRow {
  id: string;
  org_id: string;
  workspace_id: string;
  marker_id: string;
  origin: "assign" | "rule";
  mode: TriggerMode;
  agents: string[];
  grants: string[];
  budget: { tokens: number; toolCalls: number; usd: number } | null;
  run_id: string | null;
  status: string;
  requested_by: string | null;
}

const uuidFrom = (seed: string): string => {
  const h = createHash("sha256").update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/** Question handed to the child investigation: scoped to the marker's exact interval, series and units. */
export function scopedQuestion(m: Marker, t: { mode: TriggerMode; agents: string[] }): string {
  const a = m.anchor;
  const where =
    a.kind === "time_range"
      ? `the interval ${a.start} to ${a.end} (UTC)`
      : a.kind === "time_point"
        ? `the instant ${a.at} (UTC)`
        : a.kind === "threshold"
          ? `the threshold ${a.metricId} ${a.op === "gt" ? ">" : "<"} ${a.value}`
          : `the source event ${a.eventId} from ${a.sourceId} at ${a.at}`;
  // The agent receives the exact selection (never an image): the structured context is embedded verbatim as JSON.
  const sel = m.selection;
  const ctx = sel ? ` Selection: ${JSON.stringify(sel)}.` : "";
  const label = t.mode === "replay" ? "[REPLAY of recorded events, not live data] " : "";
  const roles = t.agents.length ? ` Assigned roles: ${t.agents.join(", ")}.` : "";
  return `${label}${m.question ?? "Explain what happened here."} Marker ${m.markerId}. Scope: ${where} only.${ctx}${roles}`.slice(
    0,
    4000,
  );
}

/**
 * Marker-scoped child investigations (ch.09 marker tasks, ch.05 budgets). PENDING tasks are created inside the command
 * transaction (`marker.assign`, or a fired `investigate` rule); this service starts them through the run port within the
 * task's budget cap, then links the run's outputs to the marker as evidence and moves the marker to REVIEW_REQUIRED.
 * Claiming is atomic (`status` compare-and-set), so competing dispatchers start a task at most once.
 */
export class MarkerTaskService {
  constructor(
    private readonly db: Db,
    private readonly commands: CommandBus,
    private readonly port: RunPort,
  ) {}

  private async exec(
    s: Session,
    workspaceId: string,
    commandType: "marker.link_evidence" | "marker.transition",
    payload: Record<string, unknown>,
  ): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const v = await this.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) =>
        Number(
          (await tx.query("SELECT version FROM workspaces WHERE id = $1", [workspaceId])).rows[0]?.version,
        ),
      );
      try {
        await this.commands.execute(s, workspaceId, {
          apiVersion: "v1",
          commandId: randomUUID(),
          commandType,
          payload,
          expectedVersion: v,
        });
        return;
      } catch (e) {
        if (e instanceof KernelError && e.code === "STALE_VERSION" && attempt < 8) continue;
        throw e;
      }
    }
  }

  /** Starts PENDING tasks and finishes RUNNING ones whose run is terminal. Safe to call from several processes. */
  async dispatchOpen(): Promise<{ started: number; completed: number; failed: number }> {
    const open = (
      await this.db.txGlobal((tx) =>
        tx.query<{
          task_id: string;
          org_id: string;
          workspace_id: string;
          status: string;
          requested_by: string | null;
        }>("SELECT task_id, org_id, workspace_id, status, requested_by FROM monitor_open_tasks()"),
      )
    ).rows;
    const out = { started: 0, completed: 0, failed: 0 };
    for (const o of open) {
      if (!o.requested_by) continue;
      const s = await sessionForUser(this.db, o.org_id, o.requested_by);
      const r = o.status === "PENDING" ? await this.start(o, s) : await this.sync(o, s);
      out.started += r === "started" ? 1 : 0;
      out.completed += r === "completed" ? 1 : 0;
      out.failed += r === "failed" ? 1 : 0;
    }
    return out;
  }

  private ctx(o: { org_id: string; requested_by: string | null }) {
    return { orgId: o.org_id, userId: o.requested_by! };
  }

  private async setStatus(
    o: { org_id: string; requested_by: string | null },
    id: string,
    from: string,
    to: string,
    extra?: { runId?: string; workflowId?: string; reasonCode?: string },
  ): Promise<TaskRow | undefined> {
    return this.db.tx(this.ctx(o), async (tx) => {
      const r = await tx.query<TaskRow>(
        `UPDATE marker_tasks SET status = $3, updated_at = now(), run_id = COALESCE($4, run_id), workflow_id = COALESCE($5, workflow_id),
                reason_code = COALESCE($6, reason_code)
          WHERE id = $1 AND status = $2 RETURNING *`,
        [id, from, to, extra?.runId ?? null, extra?.workflowId ?? null, extra?.reasonCode ?? null],
      );
      return r.rows[0];
    });
  }

  private async start(
    o: { task_id: string; org_id: string; workspace_id: string; requested_by: string | null },
    s: Session | null,
  ): Promise<"started" | "failed" | "skipped"> {
    const task = await this.setStatus(o, o.task_id, "PENDING", "RUNNING");
    if (!task) return "skipped"; // another dispatcher claimed it
    if (!s) {
      await this.finish(o, task, null, { ok: false, outputs: [], reasonCode: "NO_REQUESTER_SESSION" });
      return "failed";
    }
    try {
      const marker = (await this.markerOf(s, o.workspace_id, task.marker_id))!;
      const started = await this.port.start(s, o.workspace_id, {
        question: scopedQuestion(marker, task),
        budget: task.budget ?? MARKER_TASK_DEFAULT_BUDGET,
        idempotencyKey: `marker-task-${task.id}`,
        mode: task.mode,
        grants: task.grants ?? [],
      });
      await this.db.tx(this.ctx(o), (tx) =>
        tx.query("UPDATE marker_tasks SET run_id = $2, workflow_id = $3, updated_at = now() WHERE id = $1", [
          task.id,
          started.runId,
          started.workflowId,
        ]),
      );
      // ch.09 / M10 d: the marker is INVESTIGATING only once the child is durably started.
      if (task.origin === "assign" && marker.status === "ACTIVE")
        await this.exec(s, o.workspace_id, "marker.transition", {
          markerId: task.marker_id,
          to: "INVESTIGATING",
        });
      return "started";
    } catch {
      await this.finish(o, task, s, { ok: false, outputs: [], reasonCode: "WORKFLOW_START_FAILED" });
      return "failed";
    }
  }

  private async markerOf(s: Session, workspaceId: string, markerId: string): Promise<Marker | undefined> {
    // local read (avoids a dependency cycle with MonitoringService construction)
    const r = await this.db.tx({ orgId: s.principal.orgId, userId: s.userId }, (tx) =>
      tx.query("SELECT * FROM markers WHERE id = $1 AND workspace_id = $2", [markerId, workspaceId]),
    );
    const m = r.rows[0];
    if (!m) return undefined;
    return {
      markerId: m.id,
      workspaceId,
      anchorType: m.anchor_type,
      anchor: m.anchor_json,
      sourcePanelId: m.panel_id,
      sourceVersion: m.source_version,
      createdBy: m.created_by ?? null,
      question: m.question ?? null,
      assignedAgents: m.assigned_agents,
      linkedEvidenceIds: m.linked_evidence_ids,
      monitorRuleId: m.monitor_rule_id ?? null,
      resolution: m.resolution ?? null,
      timestamp: new Date(m.created_at).toISOString(),
      status: m.status,
      version: m.version,
      selection: m.selection_json ?? null,
      mode: m.mode,
      reasonCode: m.reason_code ?? null,
    };
  }

  private async sync(
    o: { task_id: string; org_id: string; workspace_id: string; requested_by: string | null },
    s: Session | null,
  ): Promise<"completed" | "failed" | "skipped"> {
    const row = (
      await this.db.tx(this.ctx(o), (tx) =>
        tx.query<TaskRow>("SELECT * FROM marker_tasks WHERE id = $1", [o.task_id]),
      )
    ).rows[0];
    if (!row || row.status !== "RUNNING" || !row.run_id) return "skipped";
    if (!s) {
      await this.finish(o, row, null, { ok: false, outputs: [], reasonCode: "NO_REQUESTER_SESSION" });
      return "failed";
    }
    const st = await this.port.status(s, row.run_id).catch(() => null);
    if (!st || !st.terminal) return "skipped";
    const claimed = await this.finish(o, row, s, {
      ok: st.succeeded,
      outputs: st.outputs,
      ...(st.succeeded ? {} : { reasonCode: st.failure?.reasonCode ?? `RUN_${st.state}` }),
    });
    return claimed ? (st.succeeded ? "completed" : "failed") : "skipped";
  }

  /** Terminal handling: atomic status claim, evidence nodes for each output, marker link, then REVIEW_REQUIRED. */
  private async finish(
    o: { org_id: string; workspace_id: string; requested_by: string | null },
    task: TaskRow,
    s: Session | null,
    res: { ok: boolean; outputs: RunOutput[]; reasonCode?: string },
  ): Promise<boolean> {
    if (task.status === "RUNNING" || task.status === "PENDING") {
      const claimed = await this.setStatus(o, task.id, task.status, res.ok ? "COMPLETE" : "FAILED", {
        ...(res.ok ? {} : { reasonCode: res.reasonCode ?? "RUN_FAILED" }),
      });
      if (!claimed) return false;
    }
    if (!res.ok) {
      // Visible non-success: the marker keeps its status (ACTIVE or INVESTIGATING) and carries the reason. It is never
      // moved to REVIEW_REQUIRED as if the investigation had produced something.
      await this.db.tx(this.ctx(o), async (tx) => {
        await tx.query("UPDATE markers SET reason_code = $2 WHERE id = $1 AND workspace_id = $3", [
          task.marker_id,
          res.reasonCode ?? "RUN_FAILED",
          o.workspace_id,
        ]);
        await writeAudit(tx, {
          orgId: o.org_id,
          workspaceId: o.workspace_id,
          actorId: o.requested_by,
          action: "marker.task_failed",
          subject: task.marker_id,
          outcome: "failed",
          reasonCode: res.reasonCode ?? "RUN_FAILED",
          detail: { taskId: task.id, runId: task.run_id },
        });
      });
      return true;
    }
    if (!s) return true;
    const ids: string[] = [];
    if (res.ok && res.outputs.length) {
      await this.db.tx(this.ctx(o), async (tx) => {
        for (const out of res.outputs) {
          const id = uuidFrom(`marker-evidence:${task.id}:${out.taskId}:${out.outputRef}`);
          ids.push(id);
          await tx.query(
            `INSERT INTO evidence_nodes(id, org_id, workspace_id, kind, label, data) VALUES ($1,$2,$3,'observation',$4,$5)
             ON CONFLICT (id) DO NOTHING`,
            [
              id,
              o.org_id,
              o.workspace_id,
              `${out.role ?? "agent"} output for marker`.slice(0, 500),
              JSON.stringify({
                markerId: task.marker_id,
                markerTaskId: task.id,
                runId: task.run_id,
                agentTaskId: out.taskId,
                outputRef: out.outputRef,
                mode: task.mode,
              }),
            ],
          );
        }
      });
      await this.exec(s, o.workspace_id, "marker.link_evidence", {
        markerId: task.marker_id,
        evidenceIds: ids,
      });
    }
    const mk = await this.markerOf(s, o.workspace_id, task.marker_id);
    if (task.origin === "assign" && mk?.status === "INVESTIGATING")
      await this.exec(s, o.workspace_id, "marker.transition", {
        markerId: task.marker_id,
        to: "REVIEW_REQUIRED",
      });
    return true;
  }
}

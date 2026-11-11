import { randomUUID } from "node:crypto";
import {
  LensCreatePayload,
  LensDeletePayload,
  LensUpdatePayload,
  MarkerAssignPayload,
  MarkerCreatePayload,
  MarkerLinkEvidencePayload,
  MarkerTransitionPayload,
  MonitorRuleCreatePayload,
  MonitorRuleTogglePayload,
  MonitorRuleUpdatePayload,
  NotificationReadPayload,
  isMarkerTransitionAllowed,
} from "@nearesis/contracts";
import type { MarkerStatus } from "@nearesis/contracts";
import { z } from "zod";
import type { CommandBus, CommandContext, HandlerResult } from "../commands.ts";
import { KernelError } from "../errors.ts";
import { zodDetails } from "../workspace.ts";
import { assertConditionBounds } from "./condition.ts";

/**
 * Hard ceiling for one marker-scoped investigation (ch.05 budget rules): the assign command may only lower it. These are
 * runtime reservation units (the same ones `POST /questions` takes; a 4-role investigation reserves more than the
 * 32k/12/3 minimum). Actual paid-model spend stays under the shared inference ledger cap regardless of this number.
 */
export const MARKER_TASK_BUDGET_CAP = { tokens: 200_000, toolCalls: 24, usd: 20 } as const;
export const MARKER_TASK_DEFAULT_BUDGET = MARKER_TASK_BUDGET_CAP;

function parse<S extends z.ZodType>(schema: S, payload: unknown): z.infer<S> {
  const r = schema.safeParse(payload);
  if (!r.success)
    throw new KernelError("VALIDATION_FAILED", "INVALID_PAYLOAD", "Invalid command payload.", {
      details: zodDetails(r.error),
    });
  return r.data;
}
const denied = () => new KernelError("FORBIDDEN", "ACCESS_DENIED", "Access denied.");

interface MarkerRow {
  id: string;
  status: MarkerStatus;
  version: number;
  assigned_agents: string[];
  linked_evidence_ids: string[];
  monitor_rule_id: string | null;
}
/** Loads a marker of THIS workspace under RLS, row-locked. Foreign and unknown markers are the same outcome. */
async function lockMarker(ctx: CommandContext, markerId: string): Promise<MarkerRow> {
  const r = await ctx.tx.query<MarkerRow>(
    `SELECT id, status, version, assigned_agents, linked_evidence_ids, monitor_rule_id FROM markers
      WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
    [markerId, ctx.workspace.id],
  );
  if (!r.rows[0]) throw denied();
  return r.rows[0];
}

export async function transitionMarker(
  ctx: CommandContext,
  markerId: string,
  to: MarkerStatus,
  extra: { resolution?: string; monitorRuleId?: string } = {},
): Promise<{ from: MarkerStatus; to: MarkerStatus; version: number }> {
  const m = await lockMarker(ctx, markerId);
  if (!isMarkerTransitionAllowed(m.status, to))
    throw new KernelError(
      "DOMAIN_INVARIANT",
      "INVALID_MARKER_TRANSITION",
      `Marker cannot move from ${m.status} to ${to}.`,
      {
        nextAction:
          "Follow DRAFT, ACTIVE, INVESTIGATING, REVIEW_REQUIRED, then RESOLVED, MONITORING or DISMISSED.",
      },
    );
  if ((to === "RESOLVED" || to === "DISMISSED") && !extra.resolution)
    throw new KernelError("VALIDATION_FAILED", "RESOLUTION_REQUIRED", "A resolution note is required.", {
      details: [{ path: "resolution", issue: "required for RESOLVED and DISMISSED" }],
    });
  if (to === "MONITORING" && !(extra.monitorRuleId ?? m.monitor_rule_id))
    throw new KernelError(
      "DOMAIN_INVARIANT",
      "MONITOR_RULE_REQUIRED",
      "A marker can only enter MONITORING with an attached monitor rule.",
    );
  await ctx.tx.query(
    `UPDATE markers SET status = $2, version = version + 1, resolution = COALESCE($3, resolution),
            monitor_rule_id = COALESCE($4, monitor_rule_id) WHERE id = $1`,
    [markerId, to, extra.resolution ?? null, extra.monitorRuleId ?? null],
  );
  return { from: m.status, to, version: m.version + 1 };
}

interface RuleRow {
  id: string;
  enabled: boolean;
  marker_id: string | null;
}
async function lockRule(ctx: CommandContext, ruleId: string): Promise<RuleRow> {
  const r = await ctx.tx.query<RuleRow>(
    "SELECT id, enabled, marker_id FROM monitor_rules WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
    [ruleId, ctx.workspace.id],
  );
  if (!r.rows[0]) throw denied();
  return r.rows[0];
}
async function assertMarkerInWorkspace(ctx: CommandContext, markerId: string): Promise<void> {
  const r = await ctx.tx.query("SELECT 1 FROM markers WHERE id = $1 AND workspace_id = $2", [
    markerId,
    ctx.workspace.id,
  ]);
  if (!r.rows[0]) throw denied();
}
async function assertPanelsInWorkspace(ctx: CommandContext, panelIds: string[]): Promise<void> {
  const ids = [...new Set(panelIds)];
  const r = await ctx.tx.query(
    "SELECT id FROM panels WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND removed_at IS NULL",
    [ids, ctx.workspace.id],
  );
  if (r.rows.length !== ids.length) throw denied();
}

/** Registers every P06 command on the bus (called by the CommandBus constructor). */
export function registerMonitoringCommands(bus: CommandBus): void {
  bus.register("marker.create", {
    handle: async (ctx, payload): Promise<HandlerResult> => {
      const p = parse(MarkerCreatePayload, payload);
      await assertPanelsInWorkspace(ctx, [p.panelId]);
      const markerId = p.markerId ?? randomUUID();
      const doc = await ctx.tx.query<{ revision: number }>(
        "SELECT revision FROM canvas_documents WHERE workspace_id = $1 AND branch_id IS NOT DISTINCT FROM $2",
        [ctx.workspace.id, ctx.workspace.activeBranchId],
      );
      // A marker is only ever created as DRAFT. The selection is stored as context; it never starts an agent (ch.09).
      await ctx.tx.query(
        `INSERT INTO markers(id, org_id, workspace_id, branch_id, panel_id, anchor_json, created_by, question,
           source_version, selection_json, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT')`,
        [
          markerId,
          ctx.workspace.orgId,
          ctx.workspace.id,
          ctx.workspace.activeBranchId,
          p.panelId,
          JSON.stringify(p.anchor),
          ctx.session.userId,
          p.question ?? null,
          doc.rows[0]?.revision ?? 0,
          p.selection ? JSON.stringify(p.selection) : null,
        ],
      );
      return {
        eventType: "marker.created",
        data: { markerId, panelId: p.panelId, anchorType: p.anchor.kind, status: "DRAFT" },
        result: { markerId },
      };
    },
  });

  bus.register("marker.transition", {
    handle: async (ctx, payload) => {
      const p = parse(MarkerTransitionPayload, payload);
      const t = await transitionMarker(
        ctx,
        p.markerId,
        p.to,
        p.resolution ? { resolution: p.resolution } : {},
      );
      return {
        eventType: "marker.transitioned",
        data: { markerId: p.markerId, from: t.from, to: t.to },
        result: { markerId: p.markerId, status: t.to, version: t.version },
      };
    },
  });

  bus.register("marker.assign", {
    handle: async (ctx, payload) => {
      const p = parse(MarkerAssignPayload, payload);
      const m = await lockMarker(ctx, p.markerId);
      // Only an explicitly saved (ACTIVE) marker can start an agent: drafts and chart-local selections cannot.
      if (m.status !== "ACTIVE")
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "MARKER_NOT_ACTIVE",
          "Agents can only be assigned to an ACTIVE marker.",
          { nextAction: "Activate the marker first." },
        );
      const budget = p.budget ?? MARKER_TASK_DEFAULT_BUDGET;
      const cap = MARKER_TASK_BUDGET_CAP;
      if (budget.tokens > cap.tokens || budget.toolCalls > cap.toolCalls || budget.usd > cap.usd)
        throw new KernelError(
          "BUDGET_EXCEEDED",
          "MARKER_BUDGET_CAP",
          "Requested budget exceeds the marker task cap.",
          {
            details: [
              {
                path: "budget",
                issue: `max ${cap.tokens} tokens, ${cap.toolCalls} tool calls, USD ${cap.usd}`,
              },
            ],
          },
        );
      const taskId = randomUUID();
      const agents = [...new Set(p.agents)];
      await ctx.tx.query(
        `INSERT INTO marker_tasks(id, org_id, workspace_id, marker_id, origin, mode, agents, budget, requested_by)
         VALUES ($1,$2,$3,$4,'assign','live',$5,$6,$7)`,
        [
          taskId,
          ctx.workspace.orgId,
          ctx.workspace.id,
          p.markerId,
          JSON.stringify(agents),
          JSON.stringify(budget),
          ctx.session.userId,
        ],
      );
      await ctx.tx.query("UPDATE markers SET assigned_agents = $2 WHERE id = $1", [
        p.markerId,
        JSON.stringify(agents),
      ]);
      const t = await transitionMarker(ctx, p.markerId, "INVESTIGATING");
      return {
        eventType: "marker.assigned",
        data: { markerId: p.markerId, taskId, agents },
        result: { markerId: p.markerId, taskId, status: t.to },
      };
    },
  });

  bus.register("marker.link_evidence", {
    handle: async (ctx, payload) => {
      const p = parse(MarkerLinkEvidencePayload, payload);
      const m = await lockMarker(ctx, p.markerId);
      const ev = await ctx.tx.query(
        "SELECT id FROM evidence_nodes WHERE id = ANY($1::uuid[]) AND workspace_id = $2",
        [p.evidenceIds, ctx.workspace.id],
      );
      if (ev.rows.length !== new Set(p.evidenceIds).size)
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "EVIDENCE_NOT_FOUND",
          "Evidence must exist in this workspace (orphan evidence is rejected).",
        );
      const merged = [...new Set([...m.linked_evidence_ids, ...p.evidenceIds])];
      await ctx.tx.query("UPDATE markers SET linked_evidence_ids = $2, version = version + 1 WHERE id = $1", [
        p.markerId,
        JSON.stringify(merged),
      ]);
      for (const id of p.evidenceIds)
        await ctx.tx.query(
          `INSERT INTO evidence_edges(id, org_id, workspace_id, from_node, to_node, relation, created_by)
           VALUES ($1,$2,$3,$4,$5,'references',$6) ON CONFLICT DO NOTHING`,
          [randomUUID(), ctx.workspace.orgId, ctx.workspace.id, p.markerId, id, ctx.session.userId],
        );
      return {
        eventType: "marker.evidence_linked",
        data: { markerId: p.markerId, evidenceIds: p.evidenceIds },
        result: { markerId: p.markerId, linkedEvidenceIds: merged },
      };
    },
  });

  // ---- lenses ----
  bus.register("lens.create", {
    handle: async (ctx, payload) => {
      const p = parse(LensCreatePayload, payload);
      await assertPanelsInWorkspace(ctx, p.panelIds);
      const lensId = p.lensId ?? randomUUID();
      await ctx.tx.query(
        `INSERT INTO lenses(id, org_id, workspace_id, name, panel_ids, filter_json, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          lensId,
          ctx.workspace.orgId,
          ctx.workspace.id,
          p.name,
          JSON.stringify(p.panelIds),
          JSON.stringify(p.filter),
          ctx.session.userId,
        ],
      );
      return { eventType: "lens.changed", data: { lensId, op: "create" }, result: { lensId } };
    },
  });
  bus.register("lens.update", {
    handle: async (ctx, payload) => {
      const p = parse(LensUpdatePayload, payload);
      if (p.panelIds) await assertPanelsInWorkspace(ctx, p.panelIds);
      const r = await ctx.tx.query(
        `UPDATE lenses SET name = COALESCE($3, name), panel_ids = COALESCE($4, panel_ids),
                filter_json = COALESCE($5, filter_json), version = version + 1
          WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING version`,
        [
          p.lensId,
          ctx.workspace.id,
          p.name ?? null,
          p.panelIds ? JSON.stringify(p.panelIds) : null,
          p.filter ? JSON.stringify(p.filter) : null,
        ],
      );
      if (!r.rows[0]) throw denied();
      return {
        eventType: "lens.changed",
        data: { lensId: p.lensId, op: "update" },
        result: { lensId: p.lensId, version: r.rows[0].version },
      };
    },
  });
  bus.register("lens.delete", {
    handle: async (ctx, payload) => {
      const p = parse(LensDeletePayload, payload);
      const r = await ctx.tx.query(
        "UPDATE lenses SET deleted_at = now(), version = version + 1 WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL RETURNING id",
        [p.lensId, ctx.workspace.id],
      );
      if (!r.rows[0]) throw denied();
      return {
        eventType: "lens.changed",
        data: { lensId: p.lensId, op: "delete" },
        result: { lensId: p.lensId },
      };
    },
  });

  // ---- monitor rules ----
  bus.register("monitor.rule_create", {
    handle: async (ctx, payload) => {
      const p = parse(MonitorRuleCreatePayload, payload);
      assertConditionBounds(p.condition);
      if (p.markerId) await assertMarkerInWorkspace(ctx, p.markerId);
      if (p.action === "investigate" && !p.markerId)
        throw new KernelError("VALIDATION_FAILED", "MARKER_REQUIRED", "An investigate rule needs a marker.", {
          details: [{ path: "markerId", issue: "required for action=investigate" }],
        });
      const ruleId = p.ruleId ?? randomUUID();
      await ctx.tx.query(
        `INSERT INTO monitor_rules(id, org_id, workspace_id, name, marker_id, source_id, condition_json,
           min_interval_seconds, debounce_seconds, cooldown_seconds, action, enabled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          ruleId,
          ctx.workspace.orgId,
          ctx.workspace.id,
          p.name,
          p.markerId ?? null,
          p.sourceId,
          JSON.stringify(p.condition),
          p.frequency.minIntervalSeconds,
          p.debounceSeconds,
          p.cooldownSeconds,
          p.action,
          p.enabled,
          ctx.session.userId,
        ],
      );
      if (p.markerId)
        await ctx.tx.query("UPDATE markers SET monitor_rule_id = $2 WHERE id = $1", [p.markerId, ruleId]);
      return {
        eventType: "monitor.rule_changed",
        data: { ruleId, op: "create", enabled: p.enabled },
        result: { ruleId },
      };
    },
  });
  bus.register("monitor.rule_update", {
    handle: async (ctx, payload) => {
      const p = parse(MonitorRuleUpdatePayload, payload);
      if (p.condition) assertConditionBounds(p.condition);
      await lockRule(ctx, p.ruleId);
      if (p.markerId) await assertMarkerInWorkspace(ctx, p.markerId);
      const r = await ctx.tx.query(
        `UPDATE monitor_rules SET name = COALESCE($2, name), condition_json = COALESCE($3, condition_json),
                min_interval_seconds = COALESCE($4, min_interval_seconds), debounce_seconds = COALESCE($5, debounce_seconds),
                cooldown_seconds = COALESCE($6, cooldown_seconds), action = COALESCE($7, action),
                marker_id = CASE WHEN $8::boolean THEN $9::uuid ELSE marker_id END,
                state_json = CASE WHEN $3::jsonb IS NULL THEN state_json ELSE '{}'::jsonb END,
                version = version + 1
          WHERE id = $1 RETURNING version, action, marker_id`,
        [
          p.ruleId,
          p.name ?? null,
          p.condition ? JSON.stringify(p.condition) : null,
          p.frequency?.minIntervalSeconds ?? null,
          p.debounceSeconds ?? null,
          p.cooldownSeconds ?? null,
          p.action ?? null,
          p.markerId !== undefined,
          p.markerId ?? null,
        ],
      );
      const row = r.rows[0] as { version: number; action: string; marker_id: string | null };
      if (row.action === "investigate" && !row.marker_id)
        throw new KernelError("VALIDATION_FAILED", "MARKER_REQUIRED", "An investigate rule needs a marker.");
      return {
        eventType: "monitor.rule_changed",
        data: { ruleId: p.ruleId, op: "update" },
        result: { ruleId: p.ruleId, version: row.version },
      };
    },
  });
  for (const [type, enabled] of [
    ["monitor.rule_enable", true],
    ["monitor.rule_disable", false],
  ] as const) {
    bus.register(type, {
      handle: async (ctx, payload) => {
        const p = parse(MonitorRuleTogglePayload, payload);
        await lockRule(ctx, p.ruleId);
        // Toggling clears debounce/cooldown state so a re-enabled rule starts clean. The row lock above serialises this
        // with any in-flight evaluation, which re-reads `enabled` under its own lock.
        await ctx.tx.query(
          "UPDATE monitor_rules SET enabled = $2, state_json = '{}'::jsonb, version = version + 1 WHERE id = $1",
          [p.ruleId, enabled],
        );
        return {
          eventType: "monitor.rule_changed",
          data: { ruleId: p.ruleId, op: enabled ? "enable" : "disable", enabled },
          result: { ruleId: p.ruleId, enabled },
        };
      },
    });
  }

  bus.register("notification.read", {
    handle: async (ctx, payload) => {
      const p = parse(NotificationReadPayload, payload);
      const r = await ctx.tx.query(
        `UPDATE notifications SET read_at = COALESCE(read_at, now()), read_by = COALESCE(read_by, $3)
          WHERE id = $1 AND workspace_id = $2 RETURNING id`,
        [p.notificationId, ctx.workspace.id, ctx.session.userId],
      );
      if (!r.rows[0]) throw denied();
      return {
        eventType: "notification.read",
        data: { notificationId: p.notificationId },
        result: { notificationId: p.notificationId },
      };
    },
  });
}

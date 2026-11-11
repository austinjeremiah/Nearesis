import type {
  Lens,
  LensFilter,
  LensResolution,
  Marker,
  MarkerTask,
  MonitorEvaluation,
  MonitorRule,
  MonitorTrigger,
  Notification,
  PanelSpec,
} from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { noWorkspaceAccess } from "../workspace.ts";

const iso = (d: Date | string): string => new Date(d).toISOString();

/** Time-series-like panel kinds a date-range lens can drive. */
const TIME_KINDS: ReadonlySet<string> = new Set(["timeSeries", "candlestick", "bar", "heatmap", "waterfall"]);

/** Read models for P06. Every read is a tenant transaction behind the workspace ACL; foreign and unknown workspaces are one outcome. */
export class MonitoringService {
  constructor(private readonly db: Db) {}

  private async scoped<T>(s: Session, workspaceId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.tx({ orgId: s.principal.orgId, userId: s.userId }, async (tx) => {
      const w = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      if (!w.rows[0]) throw noWorkspaceAccess();
      return fn(tx);
    });
  }

  listMarkers(s: Session, workspaceId: string, markerId?: string): Promise<Marker[]> {
    return this.scoped(s, workspaceId, async (tx) => {
      const r = await tx.query(
        `SELECT * FROM markers WHERE workspace_id = $1 ${markerId ? "AND id = $2" : ""} ORDER BY created_at, id`,
        markerId ? [workspaceId, markerId] : [workspaceId],
      );
      return r.rows.map((m): Marker => ({
        markerId: m.id,
        workspaceId: m.workspace_id,
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
        timestamp: iso(m.created_at),
        status: m.status,
        version: m.version,
        selection: m.selection_json ?? null,
        mode: m.mode,
        reasonCode: m.reason_code ?? null,
      }));
    });
  }

  listLenses(s: Session, workspaceId: string): Promise<Lens[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          "SELECT * FROM lenses WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY created_at, id",
          [workspaceId],
        )
      ).rows.map((l): Lens => ({
        lensId: l.id,
        workspaceId: l.workspace_id,
        name: l.name,
        panelIds: l.panel_ids,
        filter: l.filter_json,
        version: l.version,
        createdBy: l.created_by ?? null,
        createdAt: iso(l.created_at),
      })),
    );
  }

  /**
   * Which linked panels a lens filter can drive (M07). A time-range filter applies to a panel only when the panel is
   * time-based with a UTC time axis; incompatible panels are reported, never silently filtered or skipped. The lens never
   * changes a panel's certified metric definition: `appliedFilter` is a view parameter only.
   */
  resolveLens(s: Session, workspaceId: string, lensId: string): Promise<LensResolution | null> {
    return this.scoped(s, workspaceId, async (tx) => {
      const l = (
        await tx.query(
          "SELECT id, panel_ids, filter_json FROM lenses WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
          [lensId, workspaceId],
        )
      ).rows[0];
      if (!l) return null;
      const filter = l.filter_json as LensFilter;
      const specs = (
        await tx.query<{ id: string; spec: PanelSpec }>(
          `SELECT ps.id, ps.spec FROM panel_specs ps WHERE ps.id = ANY($1::uuid[]) AND ps.workspace_id = $2 AND ps.removed_at IS NULL`,
          [l.panel_ids, workspaceId],
        )
      ).rows;
      const byId = new Map(specs.map((x) => [x.id, x.spec]));
      return {
        lensId,
        panels: (l.panel_ids as string[]).map((panelId) => {
          const spec = byId.get(panelId);
          if (!spec) return { panelId, compatible: false, reason: "panel not found", appliedFilter: null };
          if (filter.timeRange) {
            if (!TIME_KINDS.has(spec.kind) || !spec.encoding.x)
              return {
                panelId,
                compatible: false,
                reason: `${spec.kind} panel has no time axis`,
                appliedFilter: null,
              };
            if (spec.dataBinding.timezone !== "UTC")
              return {
                panelId,
                compatible: false,
                reason: "panel time axis is not UTC",
                appliedFilter: null,
              };
          }
          return { panelId, compatible: true, reason: null, appliedFilter: filter };
        }),
      };
    });
  }

  listRules(s: Session, workspaceId: string): Promise<MonitorRule[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query("SELECT * FROM monitor_rules WHERE workspace_id = $1 ORDER BY created_at, id", [
          workspaceId,
        ])
      ).rows.map((r): MonitorRule => ({
        ruleId: r.id,
        workspaceId: r.workspace_id,
        name: r.name,
        markerId: r.marker_id ?? null,
        sourceId: r.source_id,
        condition: r.condition_json,
        frequency: { minIntervalSeconds: r.min_interval_seconds },
        debounceSeconds: r.debounce_seconds,
        cooldownSeconds: r.cooldown_seconds,
        action: r.action,
        enabled: r.enabled,
        version: r.version,
        createdBy: r.created_by ?? null,
        createdAt: iso(r.created_at),
        semanticVersion: r.semantic_version ?? null,
        dataMaturity: r.data_maturity,
        maxRunsPerDay: r.max_runs_per_day ?? null,
      })),
    );
  }

  listTriggers(s: Session, workspaceId: string, ruleId?: string, limit = 200): Promise<MonitorTrigger[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          `SELECT * FROM monitor_triggers WHERE workspace_id = $1 ${ruleId ? "AND rule_id = $3" : ""}
            ORDER BY evaluated_at DESC, id LIMIT $2`,
          ruleId ? [workspaceId, limit, ruleId] : [workspaceId, limit],
        )
      ).rows.map((t): MonitorTrigger => ({
        triggerId: t.id,
        ruleId: t.rule_id,
        workspaceId: t.workspace_id,
        sourceId: t.source_id,
        watermark: iso(t.watermark),
        mode: t.mode,
        outcome: t.outcome,
        observed: t.observed,
        notificationId: t.notification_id ?? null,
        evaluatedAt: iso(t.evaluated_at),
      })),
    );
  }

  listNotifications(
    s: Session,
    workspaceId: string,
    unreadOnly = false,
    limit = 200,
  ): Promise<Notification[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          `SELECT * FROM notifications WHERE workspace_id = $1 ${unreadOnly ? "AND read_at IS NULL" : ""}
            ORDER BY created_at DESC, id LIMIT $2`,
          [workspaceId, limit],
        )
      ).rows.map((n): Notification => ({
        notificationId: n.id,
        workspaceId: n.workspace_id,
        ruleId: n.rule_id,
        triggerId: n.trigger_id,
        markerId: n.marker_id ?? null,
        mode: n.mode,
        title: n.title,
        body: n.body,
        createdAt: iso(n.created_at),
        readAt: n.read_at ? iso(n.read_at) : null,
        readBy: n.read_by ?? null,
      })),
    );
  }

  listTasks(s: Session, workspaceId: string, markerId?: string): Promise<MarkerTask[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          `SELECT * FROM marker_tasks WHERE workspace_id = $1 ${markerId ? "AND marker_id = $2" : ""} ORDER BY created_at, id`,
          markerId ? [workspaceId, markerId] : [workspaceId],
        )
      ).rows.map((t): MarkerTask => ({
        taskId: t.id,
        markerId: t.marker_id,
        runId: t.run_id ?? null,
        workflowId: t.workflow_id ?? null,
        status: t.status,
        origin: t.origin,
        mode: t.mode,
        agents: t.agents,
        createdAt: iso(t.created_at),
        triggerId: t.trigger_id ?? null,
        reasonCode: t.reason_code ?? null,
        grants: t.grants ?? [],
      })),
    );
  }

  /** Every evaluation a rule performed or skipped (one row per rule, watermark, rule version and mode). */
  listEvaluations(
    s: Session,
    workspaceId: string,
    ruleId?: string,
    limit = 1000,
  ): Promise<MonitorEvaluation[]> {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          `SELECT * FROM monitor_evaluations WHERE workspace_id = $1 ${ruleId ? "AND rule_id = $3" : ""}
            ORDER BY watermark, evaluated_at, id LIMIT $2`,
          ruleId ? [workspaceId, limit, ruleId] : [workspaceId, limit],
        )
      ).rows.map((e): MonitorEvaluation => ({
        evaluationId: e.id,
        ruleId: e.rule_id,
        workspaceId: e.workspace_id,
        ruleVersion: e.rule_version,
        semanticVersion: e.semantic_version ?? null,
        sourceId: e.source_id,
        watermark: iso(e.watermark),
        mode: e.mode,
        status: e.status,
        evaluatedValue: e.evaluated_value,
        triggerId: e.trigger_id ?? null,
        taskId: e.task_id ?? null,
        evaluatedAt: iso(e.evaluated_at),
      })),
    );
  }

  /** "Live triggers today" style counters. Replay triggers are counted separately and never as live. */
  triggerCounters(s: Session, workspaceId: string, day = new Date().toISOString().slice(0, 10)) {
    return this.scoped(s, workspaceId, async (tx) => {
      const r = await tx.query<{ mode: string; n: string }>(
        `SELECT mode, count(*)::text n FROM monitor_triggers
          WHERE workspace_id = $1 AND outcome = 'fired' AND evaluated_at >= $2::date AND evaluated_at < ($2::date + 1)
          GROUP BY mode`,
        [workspaceId, day],
      );
      const n = (m: string) => Number(r.rows.find((x) => x.mode === m)?.n ?? 0);
      return { day, live: n("live"), replay: n("replay") };
    });
  }

  /**
   * Trigger history export. Each row carries its mode; replay rows are labelled in the `label` column and the report text
   * carries the word REPLAY (ch.19 step 8). Live and replay rows never share a label.
   */
  async exportTriggerHistory(s: Session, workspaceId: string) {
    const triggers = await this.listTriggers(s, workspaceId, undefined, 5000);
    const rows = triggers
      .map((t) => ({
        triggerId: t.triggerId,
        ruleId: t.ruleId,
        sourceId: t.sourceId,
        watermark: t.watermark,
        mode: t.mode,
        outcome: t.outcome,
        label: t.mode === "replay" ? "REPLAY" : "LIVE",
        evaluatedAt: t.evaluatedAt,
      }))
      .sort((a, b) => a.watermark.localeCompare(b.watermark) || a.triggerId.localeCompare(b.triggerId));
    const header = "trigger_id,rule_id,source_id,watermark,mode,outcome,label,evaluated_at";
    const csv = [
      header,
      ...rows.map((r) =>
        [r.triggerId, r.ruleId, r.sourceId, r.watermark, r.mode, r.outcome, r.label, r.evaluatedAt].join(","),
      ),
    ].join("\n");
    const replay = rows.filter((r) => r.mode === "replay").length;
    const report = `Monitoring trigger history: ${rows.length} rows, ${rows.length - replay} LIVE, ${replay} REPLAY (recorded events, not production observations).\n${csv}\n`;
    return { rows, csv, report };
  }

  /** The delegation chain recorded for a marker's children: (user, marker, agents, grants). */
  listDelegations(s: Session, workspaceId: string, markerId: string) {
    return this.scoped(s, workspaceId, async (tx) =>
      (
        await tx.query(
          "SELECT * FROM marker_delegations WHERE workspace_id = $1 AND marker_id = $2 ORDER BY created_at, id",
          [workspaceId, markerId],
        )
      ).rows.map((d) => ({
        delegationId: d.id as string,
        markerId: d.marker_id as string,
        taskId: d.task_id as string,
        userId: (d.delegator_user_id as string | null) ?? null,
        agents: d.agents as string[],
        grants: d.grants as string[],
        parentDelegationId: (d.parent_delegation_id as string | null) ?? null,
        depth: d.depth as number,
      })),
    );
  }
}

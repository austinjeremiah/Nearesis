import {
  type Condition,
  isMarkerTransitionAllowed,
  type Lens,
  type LensResolution,
  type Marker,
  type MarkerTask,
  type MonitorRule,
  type MonitorTrigger,
  type Notification,
} from "@nearesis/contracts";
import type { CommandResult, Input, MonitoringApi, MonitoringSnapshot } from "./api.ts";
import type { DelegationScopeInput } from "./api.ts";
import type {
  LensCreatePayload,
  LensUpdatePayload,
  MarkerAssignPayload,
  MarkerCreatePayload,
  MarkerLinkEvidencePayload,
  MarkerTransitionPayload,
  MonitorRuleCreatePayload,
  MonitorRuleUpdatePayload,
} from "@nearesis/contracts";

const uuid = (() => {
  let n = 0x500;
  return () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`;
})();
const ok = (value: unknown = {}): CommandResult => ({ ok: true, value });
const fail = (status: number, reasonCode: string, message: string): CommandResult => ({
  ok: false,
  status,
  reasonCode,
  message,
});

/**
 * TEST-ONLY deterministic adapter (P06 gap: the monitoring read routes and commands were not published when the UI was
 * built). It enforces the contract rules the UI relies on (transition table, one write per command) but invents no
 * progress: task status and triggers change only when a test calls `advanceTask` or `fire`.
 */
export class TestMonitoringAdapter implements MonitoringApi {
  readonly kind = "test-adapter" as const;
  private markers: Marker[] = [];
  private lenses: Lens[] = [];
  private rules: MonitorRule[] = [];
  private triggers: MonitorTrigger[] = [];
  private notifications: Notification[] = [];
  private tasks: MarkerTask[] = [];
  /** Test switch: make the next load fail with this status. */
  failNextLoad: number | null = null;
  constructor(private readonly workspaceId: string) {}

  async load() {
    if (this.failNextLoad !== null) {
      const status = this.failNextLoad;
      this.failNextLoad = null;
      return { ok: false as const, status, message: `monitoring ${status}` };
    }
    const snapshot: MonitoringSnapshot = structuredClone({
      markers: this.markers,
      lenses: this.lenses,
      rules: this.rules,
      triggers: this.triggers,
      notifications: this.notifications,
      tasks: this.tasks,
      evaluations: [],
      counters: {
        day: new Date().toISOString().slice(0, 10),
        live: this.triggers.filter((t) => t.mode === "live" && t.outcome === "fired").length,
        replay: this.triggers.filter((t) => t.mode === "replay" && t.outcome === "fired").length,
      },
    });
    return { ok: true as const, snapshot };
  }

  async createMarker(p: Input<typeof MarkerCreatePayload>) {
    const m: Marker = {
      markerId: p.markerId ?? uuid(),
      workspaceId: this.workspaceId,
      anchorType: p.anchor.kind,
      anchor: p.anchor,
      sourcePanelId: p.panelId,
      sourceVersion: 1,
      createdBy: null,
      question: p.question ?? null,
      assignedAgents: [],
      linkedEvidenceIds: [],
      monitorRuleId: null,
      resolution: null,
      timestamp: new Date().toISOString(),
      status: "DRAFT",
      version: 1,
      selection: p.selection ?? null,
      mode: "live",
      reasonCode: null,
    };
    this.markers.push(m);
    return ok({ markerId: m.markerId });
  }

  private marker(id: string) {
    return this.markers.find((m) => m.markerId === id);
  }
  async transitionMarker(p: Input<typeof MarkerTransitionPayload>) {
    const m = this.marker(p.markerId);
    if (!m) return fail(404, "NOT_FOUND", "marker not found");
    if (!isMarkerTransitionAllowed(m.status, p.to))
      return fail(422, "ILLEGAL_TRANSITION", `${m.status} -> ${p.to} is not allowed`);
    m.status = p.to;
    m.version += 1;
    if (p.resolution) m.resolution = p.resolution;
    return ok();
  }
  async assignMarker(p: Input<typeof MarkerAssignPayload>) {
    const m = this.marker(p.markerId);
    if (!m) return fail(404, "NOT_FOUND", "marker not found");
    if (m.status !== "ACTIVE") return fail(422, "ILLEGAL_STATE", "only an ACTIVE marker can be assigned");
    m.assignedAgents = [...new Set([...m.assignedAgents, ...p.agents])];
    m.status = "INVESTIGATING";
    m.version += 1;
    this.tasks.push({
      taskId: uuid(),
      markerId: m.markerId,
      runId: null,
      workflowId: null,
      status: "PENDING",
      origin: "assign",
      mode: "live",
      agents: p.agents,
      createdAt: new Date().toISOString(),
      triggerId: null,
      reasonCode: null,
      grants: [],
    });
    return ok();
  }
  async linkEvidence(p: Input<typeof MarkerLinkEvidencePayload>) {
    const m = this.marker(p.markerId);
    if (!m) return fail(404, "NOT_FOUND", "marker not found");
    m.linkedEvidenceIds = [...new Set([...m.linkedEvidenceIds, ...p.evidenceIds])];
    return ok();
  }

  async createLens(p: Input<typeof LensCreatePayload>) {
    this.lenses.push({
      lensId: p.lensId ?? uuid(),
      workspaceId: this.workspaceId,
      name: p.name,
      panelIds: p.panelIds,
      filter: p.filter,
      version: 1,
      createdBy: null,
      createdAt: new Date().toISOString(),
    });
    return ok();
  }
  async updateLens(p: Input<typeof LensUpdatePayload>) {
    const l = this.lenses.find((x) => x.lensId === p.lensId);
    if (!l) return fail(404, "NOT_FOUND", "lens not found");
    Object.assign(l, {
      ...(p.name ? { name: p.name } : {}),
      ...(p.panelIds ? { panelIds: p.panelIds } : {}),
      ...(p.filter ? { filter: p.filter } : {}),
    });
    l.version += 1;
    return ok();
  }
  async deleteLens(lensId: string) {
    this.lenses = this.lenses.filter((l) => l.lensId !== lensId);
    return ok();
  }
  /** Panels whose time grain/range is compatible are decided by the test via `incompatible`. */
  incompatible = new Map<string, string>();
  async resolveLens(lensId: string): Promise<CommandResult<LensResolution>> {
    const l = this.lenses.find((x) => x.lensId === lensId);
    if (!l) return { ok: false, status: 404, reasonCode: "NOT_FOUND", message: "lens not found" };
    return {
      ok: true,
      value: {
        lensId,
        panels: l.panelIds.map((panelId) => {
          const reason = this.incompatible.get(panelId) ?? null;
          return {
            panelId,
            compatible: reason === null,
            reason,
            appliedFilter: reason === null ? l.filter : null,
          };
        }),
      },
    };
  }

  async createRule(p: Input<typeof MonitorRuleCreatePayload>) {
    this.rules.push({
      ruleId: p.ruleId ?? uuid(),
      workspaceId: this.workspaceId,
      name: p.name,
      markerId: p.markerId ?? null,
      sourceId: p.sourceId,
      condition: p.condition as Condition,
      frequency: p.frequency ?? { minIntervalSeconds: 0 },
      debounceSeconds: p.debounceSeconds ?? 0,
      cooldownSeconds: p.cooldownSeconds ?? 0,
      action: p.action ?? "notify",
      enabled: p.enabled ?? true,
      version: 1,
      createdBy: null,
      createdAt: new Date().toISOString(),
      semanticVersion: null,
      dataMaturity: p.dataMaturity ?? "finalized_only",
      maxRunsPerDay: p.maxRunsPerDay ?? null,
    });
    return ok();
  }
  async updateRule(p: Input<typeof MonitorRuleUpdatePayload>) {
    const r = this.rules.find((x) => x.ruleId === p.ruleId);
    if (!r) return fail(404, "NOT_FOUND", "rule not found");
    const { ruleId: _id, ...rest } = p;
    Object.assign(r, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
    r.version += 1;
    return ok();
  }
  async setRuleEnabled(ruleId: string, enabled: boolean) {
    const r = this.rules.find((x) => x.ruleId === ruleId);
    if (!r) return fail(404, "NOT_FOUND", "rule not found");
    r.enabled = enabled;
    r.version += 1;
    return ok();
  }
  async markNotificationRead(id: string) {
    const n = this.notifications.find((x) => x.notificationId === id);
    if (!n) return fail(404, "NOT_FOUND", "notification not found");
    n.readAt = new Date().toISOString();
    return ok();
  }

  async exportTriggers() {
    const rows = this.triggers.map((t) => ({
      triggerId: t.triggerId,
      ruleId: t.ruleId,
      sourceId: t.sourceId,
      watermark: t.watermark,
      mode: t.mode,
      outcome: t.outcome,
      label: t.mode === "replay" ? ("REPLAY" as const) : ("LIVE" as const),
      evaluatedAt: t.evaluatedAt,
    }));
    return { ok: true as const, value: { rows, report: `TEST ADAPTER export: ${rows.length} rows` } };
  }
  async listDelegations() {
    return { ok: true as const, value: [] };
  }
  async setDelegationScope(_scope: DelegationScopeInput) {
    return ok();
  }

  // ---- test controls (never called by app code) ----
  /** Records one evaluation of a rule at a watermark, in the given mode. `fired` also creates a notification. */
  fire(ruleId: string, mode: "live" | "replay", outcome: MonitorTrigger["outcome"], watermark: string) {
    const r = this.rules.find((x) => x.ruleId === ruleId)!;
    const triggerId = uuid();
    let notificationId: string | null = null;
    if (outcome === "fired") {
      notificationId = uuid();
      this.notifications.push({
        notificationId,
        workspaceId: this.workspaceId,
        ruleId,
        triggerId,
        markerId: r.markerId,
        mode,
        title: `${r.name} fired`,
        body: `Condition held at watermark ${watermark}.`,
        createdAt: new Date().toISOString(),
        readAt: null,
        readBy: null,
      });
    }
    this.triggers.push({
      triggerId,
      ruleId,
      workspaceId: this.workspaceId,
      sourceId: r.sourceId,
      watermark,
      mode,
      outcome,
      observed: {},
      notificationId,
      evaluatedAt: new Date().toISOString(),
    });
  }
  advanceTask(markerId: string, status: MarkerTask["status"]) {
    const t = this.tasks.find((x) => x.markerId === markerId);
    if (t) t.status = status;
    const m = this.marker(markerId);
    if (m && status === "COMPLETE" && m.status === "INVESTIGATING") m.status = "REVIEW_REQUIRED";
  }
}

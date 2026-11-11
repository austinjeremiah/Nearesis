import {
  Lens,
  LensResolution,
  Marker,
  MarkerTask,
  MonitorRule,
  MonitorTrigger,
  Notification,
} from "@nearesis/contracts";
import { z } from "zod";
import type { CommandResult, MonitoringApi, MonitoringSnapshot } from "./api.ts";

/**
 * Kernel-backed implementation. Writes go through the generic `POST /v1/workspaces/:id/commands` envelope (the same one
 * the canvas uses). Read routes follow the published API (workspaces/:id/{markers,lenses,monitors,monitors/triggers,
 * notifications,marker-tasks}); every response is validated with the contract schema.
 */
export class HttpMonitoringApi implements MonitoringApi {
  readonly kind = "kernel" as const;
  constructor(private readonly workspaceId: string) {}
  private url(p: string) {
    return `/api/k/workspaces/${this.workspaceId}${p}`;
  }

  private async list<T>(path: string, key: string, item: z.ZodType<T>): Promise<T[]> {
    const r = await fetch(this.url(path), { cache: "no-store" });
    if (!r.ok) throw Object.assign(new Error(`${path} ${r.status}`), { status: r.status });
    const body = (await r.json()) as Record<string, unknown>;
    return z.array(item).parse(body[key]);
  }

  async load() {
    try {
      const [markers, lenses, rules, triggers, notifications, tasks] = await Promise.all([
        this.list("/markers", "markers", Marker),
        this.list("/lenses", "lenses", Lens),
        this.list("/monitors", "rules", MonitorRule),
        this.list("/monitors/triggers", "triggers", MonitorTrigger),
        this.list("/notifications", "notifications", Notification),
        this.list("/marker-tasks", "tasks", MarkerTask),
      ]);
      const snapshot: MonitoringSnapshot = { markers, lenses, rules, triggers, notifications, tasks };
      return { ok: true as const, snapshot };
    } catch (e) {
      return {
        ok: false as const,
        status: (e as { status?: number }).status ?? 0,
        message: (e as Error).message,
      };
    }
  }

  /**
   * One command envelope. A concurrent canvas patch (for example the selection saved just before "Monitor selection")
   * can advance the workspace version between our read and write: STALE_VERSION is retried with a fresh version and the
   * same commandId (idempotent), at most 3 times. Every other rejection is returned as is.
   */
  private async command(commandType: string, payload: unknown): Promise<CommandResult> {
    const commandId = crypto.randomUUID();
    let last: CommandResult = { ok: false, status: 0, reasonCode: "NETWORK", message: "network error" };
    for (let attempt = 0; attempt < 3; attempt++) {
      const ws = await fetch(this.url(""), { cache: "no-store" }).catch(() => null);
      if (!ws?.ok)
        return {
          ok: false,
          status: ws?.status ?? 0,
          reasonCode: "WORKSPACE_UNAVAILABLE",
          message: "workspace not accessible",
        };
      const { version } = (await ws.json()) as { version: number };
      const r = await fetch(this.url("/commands"), {
        method: "POST",
        headers: { "content-type": "application/json", "if-match": String(version) },
        body: JSON.stringify({ apiVersion: "v1", commandId, commandType, payload, expectedVersion: version }),
      }).catch(() => null);
      if (!r) return last;
      const body = (await r.json().catch(() => ({}))) as { reasonCode?: string; message?: string };
      if (r.ok) return { ok: true, value: body };
      last = {
        ok: false,
        status: r.status,
        reasonCode: body.reasonCode ?? "REJECTED",
        message: body.message ?? `HTTP ${r.status}`,
      };
      if (!(r.status === 409 && body.reasonCode === "STALE_VERSION")) return last;
    }
    return last;
  }

  createMarker = (p: object) => this.command("marker.create", p);
  transitionMarker = (p: object) => this.command("marker.transition", p);
  assignMarker = (p: object) => this.command("marker.assign", p);
  linkEvidence = (p: object) => this.command("marker.link_evidence", p);
  createLens = (p: object) => this.command("lens.create", p);
  updateLens = (p: object) => this.command("lens.update", p);
  deleteLens = (lensId: string) => this.command("lens.delete", { lensId });
  createRule = (p: object) => this.command("monitor.rule_create", p);
  updateRule = (p: object) => this.command("monitor.rule_update", p);
  setRuleEnabled = (ruleId: string, enabled: boolean) =>
    this.command(enabled ? "monitor.rule_enable" : "monitor.rule_disable", { ruleId });
  markNotificationRead = (notificationId: string) => this.command("notification.read", { notificationId });

  async resolveLens(lensId: string): Promise<CommandResult<LensResolution>> {
    const r = await fetch(this.url(`/lenses/${lensId}/resolution`), { cache: "no-store" }).catch(() => null);
    if (!r?.ok)
      return {
        ok: false,
        status: r?.status ?? 0,
        reasonCode: "RESOLUTION_UNAVAILABLE",
        message: "lens resolution unavailable",
      };
    const parsed = LensResolution.safeParse(await r.json());
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, status: 502, reasonCode: "BAD_RESPONSE", message: "lens resolution failed validation" };
  }
}

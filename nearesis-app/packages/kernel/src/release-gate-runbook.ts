import { createHash, randomUUID } from "node:crypto";
import type { Session } from "./auth.ts";
import type { Db } from "./db/pool.ts";
import { writeAudit } from "./journal.ts";
import type { PluginManager } from "./plugins/manager.ts";

export interface LeakResponseInput {
  /** The leaked secret as the incident reporter knows it. Never stored or printed; only a fingerprint is. */
  secret: string;
  pluginId: string;
  /** Rotates the credential the secret belonged to; returns once the old value is no longer accepted. */
  rotate: () => Promise<void>;
  /** Request log lines to review (the runbook never copies a line, only its position). */
  requestLogs: readonly string[];
}

export interface LeakResponseReport {
  secretFingerprint: string;
  rotated: boolean;
  pluginDisabled: boolean;
  occurrences: Array<{ source: "request_log" | "workspace_events" | "outbox"; ref: string }>;
  notificationId: string;
}

/**
 * Post-deployment playbook for a secret leak (ch.17): rotate the key, disable the plugin, review request logs and outbox
 * contents, notify the authorised owner. Every step is audited without the secret. Parameterised queries only.
 */
export class LeakRunbook {
  constructor(
    private readonly db: Db,
    private readonly plugins: Pick<PluginManager, "disable">,
  ) {}

  async run(operator: Session, input: LeakResponseInput): Promise<LeakResponseReport> {
    const orgId = operator.principal.orgId;
    const ctx = { orgId, userId: operator.userId, actorKind: operator.principal.kind };
    const fp = createHash("sha256").update(input.secret).digest("hex").slice(0, 16);
    const step = (action: string, detail: Record<string, unknown> = {}) =>
      this.db.tx(ctx, (tx) =>
        writeAudit(tx, {
          orgId,
          actorId: operator.userId,
          action,
          subject: `secret:${fp}`,
          outcome: "ok",
          detail,
        }),
      );

    await input.rotate();
    await step("leak_response.rotated");
    await this.plugins.disable(operator.userId, input.pluginId);
    await step("leak_response.plugin_disabled", { pluginId: input.pluginId });

    const occurrences: LeakResponseReport["occurrences"] = [];
    input.requestLogs.forEach((line, i) => {
      if (line.includes(input.secret)) occurrences.push({ source: "request_log", ref: `line:${i + 1}` });
    });
    const like = `%${input.secret.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    await this.db.tx(ctx, async (tx) => {
      const ev = await tx.query<{ event_id: string; workspace_id: string; seq: number }>(
        "SELECT event_id, workspace_id, seq FROM workspace_events WHERE payload::text LIKE $1 ESCAPE '\\' ORDER BY workspace_id, seq",
        [like],
      );
      for (const e of ev.rows)
        occurrences.push({ source: "workspace_events", ref: `${e.workspace_id}#${e.seq}` });
      const ob = await tx.query<{ id: string }>(
        "SELECT o.id FROM outbox o WHERE o.last_error LIKE $1 ESCAPE '\\'",
        [like],
      );
      for (const o of ob.rows) occurrences.push({ source: "outbox", ref: o.id });
    });
    await step("leak_response.reviewed", { occurrences: occurrences.length });

    const notificationId = randomUUID();
    await this.db.tx(ctx, async (tx) => {
      await tx.query(
        "INSERT INTO owner_notifications(id, org_id, kind, subject, detail) VALUES ($1,$2,$3,$4,$5)",
        [
          notificationId,
          orgId,
          "secret_leak",
          `A secret (fingerprint ${fp}) was exposed; it was rotated and plugin ${input.pluginId} disabled.`,
          JSON.stringify({ secretFingerprint: fp, pluginId: input.pluginId, occurrences }),
        ],
      );
      await writeAudit(tx, {
        orgId,
        actorId: operator.userId,
        action: "leak_response.owner_notified",
        subject: `secret:${fp}`,
        outcome: "ok",
        detail: { notificationId },
      });
    });
    return { secretFingerprint: fp, rotated: true, pluginDisabled: true, occurrences, notificationId };
  }
}

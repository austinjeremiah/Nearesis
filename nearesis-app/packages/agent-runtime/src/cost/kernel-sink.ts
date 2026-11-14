import { randomUUID } from "node:crypto";
import { writeAudit } from "@nearesis/kernel";
import type { Kernel } from "@nearesis/kernel";
import type { AlertPayload, AlertSink } from "./types.ts";

/**
 * Delivers a sent alert through the kernel's existing event path: a `notification.created` domain event on the
 * workspace journal (so it reaches the outbox, SSE streams and notification consumers like any other notification) plus
 * an audit event. Platform-level alerts (no workspace, e.g. SLO burn) are audit events with a NULL org.
 */
export function kernelAlertSink(kernel: Kernel): AlertSink {
  return {
    async send(a: AlertPayload): Promise<void> {
      const notificationId = randomUUID();
      if (a.tenantId && a.workspaceId) {
        await kernel.db.tx(
          { orgId: a.tenantId, userId: "00000000-0000-0000-0000-000000000000", actorKind: "service" },
          async (tx) => {
            await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [a.workspaceId]);
            await kernel.journal.append(tx, {
              orgId: a.tenantId!,
              workspaceId: a.workspaceId!,
              type: "notification.created",
              actorId: null,
              data: {
                notificationId,
                kind: a.kind,
                severity: a.severity,
                alertKey: a.key,
                title: a.title,
                ...a.detail,
              },
            });
            await writeAudit(tx, {
              orgId: a.tenantId,
              workspaceId: a.workspaceId,
              action: `alert.${a.kind}`,
              subject: a.key,
              outcome: "ok",
              detail: { notificationId, severity: a.severity, title: a.title },
            });
          },
        );
        return;
      }
      await kernel.db.txGlobal(async (tx) => {
        await writeAudit(tx, {
          orgId: a.tenantId,
          action: `alert.${a.kind}`,
          subject: a.key,
          outcome: "ok",
          detail: { notificationId, severity: a.severity, title: a.title, ...a.detail },
        });
      });
    },
  };
}

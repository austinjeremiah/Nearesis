import type { Kernel, Session } from "@nearesis/kernel";
import { KernelError, partOperationId } from "@nearesis/kernel";
import type { KernelCanvasExecutor } from "@nearesis/agent-runtime";

/**
 * Progressive canvas composition (ch.13 "freshly generated four-panel canvas", PERF06).
 *
 * The owner approves ONE exact patch (the approval hash covers every operation). After that approval the kernel applies it
 * operation by operation, each as its own `canvas.apply_patch` command, so every panel is committed, journalled and
 * streamed over the existing SSE channel (`canvas.patched`) as soon as it exists instead of after the last one. Per panel
 * a `query.completed` event follows with its status:
 *
 *   QUERYING  the panel was added (its `canvas.patched` event) and its `query.completed` has not arrived yet; the panel
 *             spec carries a query reference only, never data, so nothing is shown as a result while it is pending;
 *   READY     `query.completed` {status:"READY"}: the operation committed and the panel's query reference is the one that
 *             `canvas.preview` validated and executed before the owner was asked;
 *   ERROR     `query.completed` {status:"ERROR", reasonCode}: the operation was rejected; later operations are not applied.
 *
 * One approval, many commands, exactly once: the kernel splits the approved action into single-use derived approvals (one
 * per operation, `ApprovalService.delegateParts`); each operation carries the deterministic operation id of its part. An
 * operation already recorded in `canvas_patches` is skipped on a retry, so a crashed or retried execution continues where
 * it stopped and never applies a panel twice, and no operation can run without the owner's approval of the whole patch.
 */
export type PanelStatus = "QUERYING" | "READY" | "ERROR";

export interface ProgressiveResult {
  state: "ok" | "rejected";
  total: number;
  applied: number;
  skipped: number;
  workspaceVersion: number | null;
  eventSeq: number | null;
  failure?: { index: number; reasonCode: string; issues: unknown[] };
}

export async function applyProgressively(a: {
  kernel: Kernel;
  exec: KernelCanvasExecutor;
  session: Session;
  workspaceId: string;
  runId: string;
  actionHash: string;
  patch: { operations: Array<Record<string, unknown>> } & Record<string, unknown>;
}): Promise<ProgressiveResult> {
  const ops = a.patch.operations;
  const ctx = {
    orgId: a.session.principal.orgId,
    userId: a.session.userId,
    actorKind: a.session.principal.kind,
  };
  const already = async (operationId: string): Promise<boolean> =>
    a.kernel.db.tx(
      ctx,
      async (tx) =>
        (
          await tx.query("SELECT 1 FROM canvas_patches WHERE workspace_id = $1 AND operation_id = $2", [
            a.workspaceId,
            operationId,
          ])
        ).rowCount === 1,
    );
  const status = async (
    op: Record<string, unknown>,
    index: number,
    s: PanelStatus,
    reasonCode?: string,
  ): Promise<void> => {
    const panel = op.panel as { panelId?: string; queryRef?: { hash?: string } } | undefined;
    if (op.op !== "addPanel" || !panel?.panelId) return;
    await a.kernel.db.tx(ctx, async (tx) => {
      await tx.query("SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE", [a.workspaceId]);
      await a.kernel.journal.append(tx, {
        orgId: a.session.principal.orgId,
        workspaceId: a.workspaceId,
        type: "query.completed",
        actorId: a.session.userId,
        causationId: a.runId,
        data: {
          runId: a.runId,
          panelId: panel.panelId,
          queryHash: panel.queryRef?.hash ?? null,
          status: s,
          index,
          total: ops.length,
          ...(reasonCode ? { reasonCode } : {}),
        },
      });
    });
  };

  // One approval, many commands: for an agent (whose canvas patch the kernel only accepts under an approval) the approved
  // action is split into one single-use derived approval per operation; the kernel consumes the parent here, atomically,
  // and is idempotent on a retried execution. A human session needs no approval, only the same deterministic ids.
  const opIds =
    a.session.principal.kind === "agent"
      ? await a.kernel.db.tx(ctx, (tx) =>
          a.kernel.approvals.delegateParts(tx, {
            workspaceId: a.workspaceId,
            runId: a.runId,
            actionHash: a.actionHash,
            parts: ops.length,
            usedBy: a.runId,
          }),
        )
      : ops.map((_, i) => partOperationId(a.actionHash, i));

  let applied = 0;
  let skipped = 0;
  let last: { workspaceVersion: number; eventSeq: number } | null = null;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const operationId = opIds[i]!;
    if (await already(operationId)) {
      skipped++;
      continue;
    }
    try {
      const revision = await a.exec.documentRevision(a.session, a.workspaceId);
      last = await a.exec.apply(a.session, a.workspaceId, {
        ...a.patch,
        operations: [op],
        expectedRevision: revision,
        operationId,
      } as never);
      applied++;
    } catch (e) {
      if (e instanceof KernelError && e.code === "VALIDATION_FAILED") {
        await status(op, i, "ERROR", e.reasonCode);
        return {
          state: "rejected",
          total: ops.length,
          applied,
          skipped,
          workspaceVersion: last?.workspaceVersion ?? null,
          eventSeq: last?.eventSeq ?? null,
          failure: { index: i, reasonCode: e.reasonCode, issues: e.opts.details ?? [] },
        };
      }
      throw e;
    }
    await status(op, i, "READY");
  }
  return {
    state: "ok",
    total: ops.length,
    applied,
    skipped,
    workspaceVersion: last?.workspaceVersion ?? null,
    eventSeq: last?.eventSeq ?? null,
  };
}

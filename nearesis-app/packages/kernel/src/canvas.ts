import { CanvasPatch } from "@nearesis/contracts";
import type { CanvasDocument, MarkerSpec, PanelSpec, Selection } from "@nearesis/contracts";
import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import { randomUUID } from "node:crypto";
import type { CommandHandler, CommandContext } from "./commands.ts";
import type { Db, Tx } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { noWorkspaceAccess, zodDetails } from "./workspace.ts";
import type { Session } from "./auth.ts";

export interface SemanticValidationResult {
  ok: boolean;
  errors: Array<{ path: string; message: string }>;
}
/** Hook for Engine B's canvas-schema: run inside the command transaction against the pre-patch document. */
export type SemanticValidator = (doc: CanvasDocument, patch: CanvasPatch) => SemanticValidationResult;

interface LayoutJson {
  viewport: { zoom: number; x: number; y: number };
  layoutMode: "grid" | "freeform";
  activeSelections: Selection[];
}
const DEFAULT_LAYOUT: LayoutJson = {
  viewport: { zoom: 1, x: 0, y: 0 },
  layoutMode: "grid",
  activeSelections: [],
};

export const MAX_PANELS = 200;
export const MAX_MARKERS = 2000;
export const MAX_SELECTIONS = 50;

function contentHash(
  d: Pick<CanvasDocument, "panels" | "markers" | "viewport" | "layoutMode" | "activeSelections">,
): string {
  const byId = <T extends Record<string, unknown>>(a: T[], k: string) =>
    [...a].sort((x, y) => String(x[k]).localeCompare(String(y[k])));
  return sha256Hex(
    canonicalJson({
      panels: byId(d.panels as unknown as Array<Record<string, unknown>>, "panelId"),
      markers: byId(d.markers as unknown as Array<Record<string, unknown>>, "markerId"),
      viewport: d.viewport,
      layoutMode: d.layoutMode,
      activeSelections: byId(d.activeSelections as unknown as Array<Record<string, unknown>>, "panelId"),
    }),
  );
}

/** Canvas persistence + the `canvas.apply_patch` command handler. */
export class CanvasService {
  constructor(
    private readonly db: Db,
    private readonly semanticValidator?: SemanticValidator,
  ) {}

  /** Load the canvas document of a workspace branch; null if no patch has ever been applied. Caller holds a tenant tx. */
  async load(tx: Tx, workspaceId: string, branchId: string): Promise<CanvasDocument | null> {
    const d = (
      await tx.query("SELECT * FROM canvas_documents WHERE workspace_id = $1 AND branch_id = $2", [
        workspaceId,
        branchId,
      ])
    ).rows[0];
    if (!d) return null;
    const panels = (
      await tx.query(
        "SELECT spec FROM panel_specs WHERE document_id = $1 AND removed_at IS NULL ORDER BY created_at, id",
        [d.id],
      )
    ).rows.map((r) => r.spec as PanelSpec);
    const markers = (
      await tx.query(
        `SELECT m.* FROM markers m JOIN panels p ON p.id = m.panel_id
         WHERE m.workspace_id = $1 AND p.removed_at IS NULL ORDER BY m.created_at, m.id`,
        [workspaceId],
      )
    ).rows.map((m): MarkerSpec => ({
      markerId: m.id,
      panelId: m.panel_id,
      anchor: m.anchor_json,
      status: m.status,
      ...(m.question ? { question: m.question } : {}),
      createdBy: m.created_by ?? m.org_id,
      createdAt: new Date(m.created_at).toISOString(),
    }));
    const layout = d.layout_json as LayoutJson;
    return {
      id: d.id,
      workspaceId,
      branchId,
      documentRevision: d.revision,
      dataRevision: d.data_revision,
      viewport: layout.viewport,
      layoutMode: layout.layoutMode,
      panels,
      markers,
      activeSelections: layout.activeSelections,
      updatedAt: new Date(d.updated_at).toISOString(),
    };
  }

  /** Member read of the canvas document (empty revision-0 document if untouched). */
  async get(session: Session, workspaceId: string): Promise<CanvasDocument> {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const ws = (await tx.query("SELECT active_branch_id FROM workspaces WHERE id = $1", [workspaceId]))
        .rows[0];
      if (!ws) throw noWorkspaceAccess();
      const doc = await this.load(tx, workspaceId, ws.active_branch_id);
      return (
        doc ?? {
          id: randomUUID(),
          workspaceId,
          branchId: ws.active_branch_id,
          documentRevision: 0,
          dataRevision: 0,
          ...DEFAULT_LAYOUT,
          panels: [],
          markers: [],
          updatedAt: new Date(0).toISOString(),
        }
      );
    });
  }

  /** Bump dataRevision only (data refresh). Layout/documentRevision untouched (C18). */
  async bumpDataRevision(session: Session, workspaceId: string): Promise<number> {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const r = await tx.query(
        `UPDATE canvas_documents SET data_revision = data_revision + 1, updated_at = now()
         WHERE workspace_id = $1 AND branch_id = (SELECT active_branch_id FROM workspaces WHERE id = $1) RETURNING data_revision`,
        [workspaceId],
      );
      if (!r.rows[0]) throw new KernelError("NOT_FOUND", "NO_CANVAS", "Canvas has no document yet.");
      return r.rows[0].data_revision as number;
    });
  }

  readonly handler: CommandHandler = {
    handle: async (ctx, payload) => this.apply(ctx, payload),
  };

  /** Apply a CanvasPatch atomically: validate everything first, then write; any failure leaves no trace (422). */
  private async apply(ctx: CommandContext, payload: Record<string, unknown>) {
    const parsed = CanvasPatch.safeParse(payload);
    if (!parsed.success) {
      throw new KernelError("VALIDATION_FAILED", "INVALID_PATCH", "Canvas patch failed validation.", {
        details: zodDetails(parsed.error),
      });
    }
    const patch = parsed.data;
    const { tx, workspace, session } = ctx;
    const branchId = workspace.activeBranchId!;
    let doc = await this.load(tx, workspace.id, branchId);
    let docId = doc?.id;
    if (!doc) {
      docId = randomUUID();
      const lay = DEFAULT_LAYOUT;
      doc = {
        id: docId,
        workspaceId: workspace.id,
        branchId,
        documentRevision: 0,
        dataRevision: 0,
        ...lay,
        panels: [],
        markers: [],
        activeSelections: [],
        updatedAt: new Date().toISOString(),
      };
      await tx.query(
        "INSERT INTO canvas_documents(id, org_id, workspace_id, branch_id, layout_json, revision, data_revision, content_hash) VALUES ($1,$2,$3,$4,$5,0,0,$6)",
        [docId, workspace.orgId, workspace.id, branchId, JSON.stringify(lay), contentHash(doc)],
      );
    }
    if (patch.expectedRevision !== doc.documentRevision) {
      throw new KernelError("STALE_VERSION", "STALE_DOCUMENT_REVISION", "Canvas changed since it was read.", {
        retryable: true,
        lastStableRevision: doc.documentRevision,
        nextAction: "Reload the canvas and rebase the patch.",
      });
    }

    // Engine B semantic validation (hook), then structural reference checks, over an in-memory copy.
    const problems: Array<{ path: string; issue: string }> = [];
    if (this.semanticValidator) {
      const sem = this.semanticValidator(doc, patch);
      if (!sem.ok) for (const e of sem.errors) problems.push({ path: e.path, issue: e.message });
    }
    const panels = new Map(doc.panels.map((p) => [p.panelId, p]));
    const markers = new Map(doc.markers.map((m) => [m.markerId, m]));
    const selections = new Map(doc.activeSelections.map((s) => [s.panelId, s]));
    const writes: Array<() => Promise<void>> = [];
    const summary: Array<Record<string, string>> = [];
    const known = (id: string) => panels.has(id);
    patch.operations.forEach((op, i) => {
      const at = `operations.${i}`;
      switch (op.op) {
        case "addPanel": {
          const p = op.panel;
          if (panels.has(p.panelId))
            problems.push({ path: `${at}.panel.panelId`, issue: "panel already exists" });
          else if (panels.size >= MAX_PANELS)
            problems.push({ path: at, issue: `canvas is limited to ${MAX_PANELS} panels` });
          else {
            panels.set(p.panelId, p);
            writes.push(async () => {
              // Soft-removed id reuse is refused: the identity row survives removal.
              await tx.query("INSERT INTO panels(id, org_id, workspace_id, kind) VALUES ($1,$2,$3,$4)", [
                p.panelId,
                workspace.orgId,
                workspace.id,
                p.kind,
              ]);
              await tx.query(
                `INSERT INTO panel_specs(id, org_id, workspace_id, document_id, query_hash, schema_version, kind, spec, layout_json)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                  p.panelId,
                  workspace.orgId,
                  workspace.id,
                  docId,
                  p.queryRef.hash,
                  p.schemaVersion,
                  p.kind,
                  JSON.stringify(p),
                  JSON.stringify(p.layout),
                ],
              );
            });
          }
          summary.push({ op: op.op, panelId: p.panelId });
          break;
        }
        case "updatePanel":
        case "movePanel": {
          const cur = panels.get(op.panelId);
          if (!cur) {
            problems.push({ path: `${at}.panelId`, issue: "unknown panel" });
            break;
          }
          if (op.op === "updatePanel" && op.panel.panelId !== op.panelId) {
            problems.push({ path: `${at}.panel.panelId`, issue: "panelId must match the target panel" });
            break;
          }
          const next: PanelSpec = op.op === "updatePanel" ? op.panel : { ...cur, layout: op.layout };
          panels.set(op.panelId, next);
          writes.push(async () => {
            await tx.query(
              "UPDATE panel_specs SET spec=$2, layout_json=$3, query_hash=$4, kind=$5 WHERE id=$1",
              [op.panelId, JSON.stringify(next), JSON.stringify(next.layout), next.queryRef.hash, next.kind],
            );
          });
          summary.push({ op: op.op, panelId: op.panelId });
          break;
        }
        case "removePanel": {
          if (!panels.delete(op.panelId)) {
            problems.push({ path: `${at}.panelId`, issue: "unknown panel" });
            break;
          }
          for (const [mid, m] of markers) if (m.panelId === op.panelId) markers.delete(mid);
          selections.delete(op.panelId);
          writes.push(async () => {
            await tx.query("UPDATE panel_specs SET removed_at = now() WHERE id = $1", [op.panelId]);
            await tx.query("UPDATE panels SET removed_at = now() WHERE id = $1", [op.panelId]);
          });
          summary.push({ op: op.op, panelId: op.panelId });
          break;
        }
        case "addMarker": {
          const m = op.marker;
          if (!known(m.panelId)) problems.push({ path: `${at}.marker.panelId`, issue: "unknown panel" });
          else if (markers.has(m.markerId))
            problems.push({ path: `${at}.marker.markerId`, issue: "marker already exists" });
          else if (markers.size >= MAX_MARKERS)
            problems.push({ path: at, issue: `canvas is limited to ${MAX_MARKERS} markers` });
          else {
            markers.set(m.markerId, m);
            writes.push(async () => {
              await tx.query(
                `INSERT INTO markers(id, org_id, workspace_id, branch_id, panel_id, anchor_json, status, question, created_by, created_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                  m.markerId,
                  workspace.orgId,
                  workspace.id,
                  branchId,
                  m.panelId,
                  JSON.stringify(m.anchor),
                  m.status,
                  m.question ?? null,
                  session.userId,
                  m.createdAt,
                ],
              );
            });
          }
          summary.push({ op: op.op, markerId: m.markerId, panelId: m.panelId });
          break;
        }
        case "setSelection": {
          const s = op.selection;
          if (!known(s.panelId)) problems.push({ path: `${at}.selection.panelId`, issue: "unknown panel" });
          else if (!selections.has(s.panelId) && selections.size >= MAX_SELECTIONS)
            problems.push({ path: at, issue: `at most ${MAX_SELECTIONS} active selections` });
          else selections.set(s.panelId, s);
          summary.push({ op: op.op, panelId: s.panelId });
          break;
        }
      }
    });
    if (problems.length) {
      throw new KernelError(
        "VALIDATION_FAILED",
        "PATCH_REJECTED",
        "Canvas patch rejected; nothing was applied.",
        {
          details: problems.slice(0, 100),
          lastStableRevision: doc.documentRevision,
        },
      );
    }

    for (const w of writes) await w();
    const next = {
      panels: [...panels.values()],
      markers: [...markers.values()],
      viewport: doc.viewport,
      layoutMode: doc.layoutMode,
      activeSelections: [...selections.values()],
    };
    const hash = contentHash(next);
    const revision = doc.documentRevision + 1;
    await tx.query(
      "UPDATE canvas_documents SET revision=$2, layout_json=$3, content_hash=$4, updated_at=now() WHERE id=$1",
      [
        docId,
        revision,
        JSON.stringify({
          viewport: next.viewport,
          layoutMode: next.layoutMode,
          activeSelections: next.activeSelections,
        }),
        hash,
      ],
    );
    return {
      eventType: "canvas.patched" as const,
      data: {
        operationId: patch.operationId,
        documentRevision: revision,
        dataRevision: doc.dataRevision,
        contentHash: hash,
        operations: summary,
      },
      result: { documentRevision: revision, contentHash: hash },
    };
  }
}

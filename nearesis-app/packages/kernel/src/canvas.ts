import { CanvasPatch, isMarkerTransitionAllowed } from "@nearesis/contracts";
import { applyCanvasPatch, documentContentHash } from "@nearesis/canvas-schema";
import type { CanvasDocument, MarkerSpec, PanelSpec, Selection } from "@nearesis/contracts";
import { canonicalJson } from "@nearesis/plugin-sdk";
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
    if (!doc) {
      const lay = DEFAULT_LAYOUT;
      doc = {
        id: randomUUID(),
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
        [doc.id, workspace.orgId, workspace.id, branchId, JSON.stringify(lay), documentContentHash(doc)],
      );
    }
    if (patch.expectedRevision !== doc.documentRevision) {
      throw new KernelError("STALE_VERSION", "STALE_DOCUMENT_REVISION", "Canvas changed since it was read.", {
        retryable: true,
        lastStableRevision: doc.documentRevision,
        nextAction: "Reload the canvas and rebase the patch.",
      });
    }

    // Optional extra hook first, then Engine B's semantic validation + pure apply (all-or-nothing, dataRevision untouched).
    const problems: Array<{ path: string; issue: string }> = [];
    if (this.semanticValidator) {
      const sem = this.semanticValidator(doc, patch);
      if (!sem.ok) for (const e of sem.errors) problems.push({ path: e.path, issue: e.message });
    }
    const res = problems.length ? null : applyCanvasPatch(doc, patch, { now: new Date().toISOString() });
    if (res && !res.ok) for (const i of res.issues) problems.push({ path: i.path, issue: i.message });
    if (problems.length || !res || !res.ok) {
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
    const next = res.document;
    await this.persistDiff(tx, ctx, doc, next);
    const hash = documentContentHash(next);
    await tx.query(
      "UPDATE canvas_documents SET revision=$2, layout_json=$3, content_hash=$4, updated_at=now() WHERE id=$1",
      [
        doc.id,
        next.documentRevision,
        JSON.stringify({
          viewport: next.viewport,
          layoutMode: next.layoutMode,
          activeSelections: next.activeSelections,
        }),
        hash,
      ],
    );
    await tx.query(
      `INSERT INTO canvas_patches(id, org_id, workspace_id, document_id, operation_id, revision, patch, inverse, preview_hash, applied_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        randomUUID(),
        workspace.orgId,
        workspace.id,
        doc.id,
        patch.operationId,
        next.documentRevision,
        JSON.stringify(patch),
        JSON.stringify(res.inverse),
        res.previewHash,
        session.userId,
      ],
    );
    const summary = patch.operations.map((o) => {
      const x = o as Record<string, unknown>;
      const ref = (x.panelId ??
        x.markerId ??
        (x.panel as { panelId?: string } | undefined)?.panelId ??
        (x.marker as { markerId?: string } | undefined)?.markerId ??
        (x.selection as { panelId?: string } | undefined)?.panelId) as string;
      return { op: o.op, ref };
    });
    return {
      eventType: "canvas.patched" as const,
      data: {
        operationId: patch.operationId,
        documentRevision: next.documentRevision,
        dataRevision: next.dataRevision,
        contentHash: hash,
        previewHash: res.previewHash,
        operations: summary,
      },
      result: { documentRevision: next.documentRevision, contentHash: hash },
    };
  }

  /** Inverse operations recorded for a revision (undo source). */
  async inverseOf(session: Session, workspaceId: string, revision: number): Promise<unknown[] | null> {
    return this.db.tx({ orgId: session.principal.orgId, userId: session.userId }, async (tx) => {
      const r = await tx.query(
        "SELECT inverse FROM canvas_patches WHERE workspace_id = $1 AND revision = $2",
        [workspaceId, revision],
      );
      return r.rows[0] ? (r.rows[0].inverse as unknown[]) : null;
    });
  }

  /** Write the difference between two documents. Panels are soft-removed so identities survive undo. */
  private async persistDiff(
    tx: Tx,
    ctx: CommandContext,
    before: CanvasDocument,
    after: CanvasDocument,
  ): Promise<void> {
    const { workspace, session } = ctx;
    const bp = new Map(before.panels.map((p) => [p.panelId, p]));
    const ap = new Map(after.panels.map((p) => [p.panelId, p]));
    for (const [id, p] of ap) {
      const old = bp.get(id);
      if (old && canonicalJson(old) === canonicalJson(p)) continue;
      const exists = old
        ? true
        : (await tx.query("SELECT 1 FROM panels WHERE id = $1", [id])).rows.length > 0;
      if (!exists) {
        await tx.query("INSERT INTO panels(id, org_id, workspace_id, kind) VALUES ($1,$2,$3,$4)", [
          id,
          workspace.orgId,
          workspace.id,
          p.kind,
        ]);
        await tx.query(
          `INSERT INTO panel_specs(id, org_id, workspace_id, document_id, query_hash, schema_version, kind, spec, layout_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            workspace.orgId,
            workspace.id,
            before.id,
            p.queryRef.hash,
            p.schemaVersion,
            p.kind,
            JSON.stringify(p),
            JSON.stringify(p.layout),
          ],
        );
      } else {
        await tx.query("UPDATE panels SET removed_at = NULL, kind = $2 WHERE id = $1", [id, p.kind]);
        await tx.query(
          "UPDATE panel_specs SET spec=$2, layout_json=$3, query_hash=$4, kind=$5, removed_at=NULL WHERE id=$1",
          [id, JSON.stringify(p), JSON.stringify(p.layout), p.queryRef.hash, p.kind],
        );
      }
    }
    for (const id of bp.keys()) {
      if (ap.has(id)) continue;
      await tx.query("UPDATE panel_specs SET removed_at = now() WHERE id = $1", [id]);
      await tx.query("UPDATE panels SET removed_at = now() WHERE id = $1", [id]);
    }
    const bm = new Map(before.markers.map((m) => [m.markerId, m]));
    const am = new Map(after.markers.map((m) => [m.markerId, m]));
    for (const [id, m] of am) {
      const old = bm.get(id);
      if (old && canonicalJson(old) === canonicalJson(m)) continue;
      if (old && old.status !== m.status && !isMarkerTransitionAllowed(old.status, m.status)) {
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "INVALID_MARKER_TRANSITION",
          `Marker cannot move from ${old.status} to ${m.status}.`,
        );
      }
      if (!old && m.status !== "DRAFT") {
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "INVALID_MARKER_TRANSITION",
          "A new marker starts as DRAFT.",
        );
      }
      if (old) {
        await tx.query(
          "UPDATE markers SET anchor_json=$2, status=$3, question=$4, panel_id=$5, version = version + 1 WHERE id=$1",
          [id, JSON.stringify(m.anchor), m.status, m.question ?? null, m.panelId],
        );
      } else {
        await tx.query(
          `INSERT INTO markers(id, org_id, workspace_id, branch_id, panel_id, anchor_json, status, question, created_by, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            workspace.orgId,
            workspace.id,
            after.branchId,
            m.panelId,
            JSON.stringify(m.anchor),
            m.status,
            m.question ?? null,
            m.createdBy ?? session.userId,
            m.createdAt,
          ],
        );
      }
    }
    for (const [id, old] of bm) {
      if (am.has(id)) continue;
      // Only an unsaved DRAFT can be deleted; a saved marker leaves the board by being DISMISSED or RESOLVED (it carries
      // tasks, rules and evidence links).
      if (old.status !== "DRAFT")
        throw new KernelError(
          "DOMAIN_INVARIANT",
          "MARKER_NOT_DELETABLE",
          "Only a DRAFT marker can be removed; dismiss or resolve it instead.",
        );
      await tx.query("DELETE FROM markers WHERE id = $1", [id]);
    }
  }
}

import { randomUUID } from "node:crypto";
import { documentContentHash } from "@nearesis/canvas-schema";
import type { Tx } from "./db/pool.ts";

/** Canvas CONFIG a workspace template can seed. No panels, markers or data: those come from certified queries only. */
export interface CanvasSeedLayout {
  viewport: { zoom: number; x: number; y: number };
  layoutMode: "grid" | "freeform";
}

/**
 * Create the canvas document of a brand-new workspace branch with a template layout (revision 0, no panels). The first
 * `canvas.apply_patch` then continues from this document exactly as it would from the default one. Caller holds the tenant tx.
 */
export async function seedCanvasDocument(
  tx: Tx,
  a: { orgId: string; workspaceId: string; branchId: string; layout: CanvasSeedLayout },
): Promise<string> {
  const id = randomUUID();
  const layout = { viewport: a.layout.viewport, layoutMode: a.layout.layoutMode, activeSelections: [] };
  const hash = documentContentHash({
    id,
    workspaceId: a.workspaceId,
    branchId: a.branchId,
    documentRevision: 0,
    dataRevision: 0,
    ...layout,
    panels: [],
    markers: [],
    updatedAt: new Date(0).toISOString(),
  });
  await tx.query(
    "INSERT INTO canvas_documents(id, org_id, workspace_id, branch_id, layout_json, revision, data_revision, content_hash) VALUES ($1,$2,$3,$4,$5,0,0,$6)",
    [id, a.orgId, a.workspaceId, a.branchId, JSON.stringify(layout), hash],
  );
  return id;
}

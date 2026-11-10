import {
  CanvasDocument,
  CanvasPatch,
  type MarkerSpec,
  type PanelSpec,
  type PatchOp,
  type Selection,
} from "@nearesis/contracts";
import { hashCanonical } from "./hash.ts";
import { type Issue, zodIssues } from "./issues.ts";
import { findExecutableContent, panelSemanticIssues, type ValidationContext } from "./panel.ts";

/** Patch operations, including the inverse ops `removeMarker` / `clearSelection` (contracts 1.1.0). */
type Op = PatchOp;
/** @deprecated use the contract `PatchOp`; kept as an alias for existing imports. */
export type LocalOp = PatchOp;

export interface PatchReport {
  ok: boolean;
  issues: Issue[];
  /** One entry per operation: valid or the issues attached to that operation index. */
  operations: Array<{ index: number; op: string; ok: boolean; issues: Issue[] }>;
}

export interface ApplyResult {
  ok: true;
  document: CanvasDocument;
  /** Operations that undo this patch exactly, in application order (C06). */
  inverse: Op[];
  previewHash: string;
}

/** Deterministic document order so that apply → inverse returns a byte-identical document. */
export function normalizeDocument(doc: CanvasDocument): CanvasDocument {
  const panels = [...doc.panels].sort(
    (a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.panelId.localeCompare(b.panelId),
  );
  const markers = [...doc.markers].sort((a, b) => a.markerId.localeCompare(b.markerId));
  const activeSelections = [...doc.activeSelections].sort((a, b) => a.panelId.localeCompare(b.panelId));
  return { ...doc, panels, markers, activeSelections };
}

function anchorIssue(m: MarkerSpec): string | null {
  const a = m.anchor;
  if (a.kind === "time_range" && Date.parse(a.start) > Date.parse(a.end))
    return "time_range start is after end";
  if (a.kind === "threshold" && !Number.isFinite(a.value)) return "threshold value must be finite";
  return null;
}

/**
 * Pure semantic validation of a patch against a document (the kernel calls this inside its transaction, per the
 * 11:50Z ownership decision). Returns every issue; the patch is applicable only if `ok` (all-or-nothing, C11).
 */
export function validateCanvasPatchSemantics(
  doc: CanvasDocument,
  patch: unknown,
  ctx: ValidationContext = {},
): PatchReport {
  const exec = findExecutableContent(patch, "patch");
  const parsed = exec.length ? null : CanvasPatch.safeParse(patch);
  if (!parsed || !parsed.success) {
    const issues = [...exec, ...(parsed && !parsed.success ? zodIssues(parsed.error, "patch") : [])];
    const byOp = new Map<number, Issue[]>();
    for (const i of issues) {
      const m = /^patch\.operations\.(\d+)/.exec(i.path);
      if (m) {
        const idx = Number(m[1]);
        i.opIndex = idx;
        byOp.set(idx, [...(byOp.get(idx) ?? []), i]);
      }
    }
    const opsDesc =
      patch && typeof patch === "object" ? Object.getOwnPropertyDescriptor(patch, "operations") : undefined;
    const ops: Array<{ op?: unknown }> = Array.isArray(opsDesc?.value) ? opsDesc.value : [];
    return {
      ok: false,
      issues,
      operations: ops.map((o, index) => ({
        index,
        op:
          typeof Object.getOwnPropertyDescriptor(o ?? {}, "op")?.value === "string"
            ? String(o.op)
            : "unknown",
        ok: !byOp.has(index),
        issues: byOp.get(index) ?? [],
      })),
    };
  }
  return simulate(doc, parsed.data.operations, ctx, parsed.data.expectedRevision).report;
}

function simulate(
  doc: CanvasDocument,
  ops: readonly Op[],
  ctx: ValidationContext,
  expectedRevision: number | null,
): { report: PatchReport; doc: CanvasDocument; inverse: Op[] } {
  const issues: Issue[] = [];
  const opReports: PatchReport["operations"] = [];
  if (expectedRevision !== null && expectedRevision !== doc.documentRevision)
    issues.push({
      code: "STALE_REVISION",
      path: "patch.expectedRevision",
      message: `expected revision ${expectedRevision}, document is at ${doc.documentRevision}`,
    });
  const panels = new Map<string, PanelSpec>(doc.panels.map((p) => [p.panelId, p]));
  const markers = new Map<string, MarkerSpec>(doc.markers.map((m) => [m.markerId, m]));
  const selections = new Map<string, Selection>(doc.activeSelections.map((s) => [s.panelId, s]));
  const inverse: Op[] = [];

  ops.forEach((op, index) => {
    const local: Issue[] = [];
    const add = (code: Issue["code"], path: string, message: string) =>
      local.push({ code, path: `patch.operations.${index}.${path}`, message, opIndex: index });
    switch (op.op) {
      case "addPanel": {
        if (panels.has(op.panel.panelId))
          add("DUPLICATE_PANEL_ID", "panel.panelId", "panelId already exists");
        for (const i of panelSemanticIssues(op.panel, ctx, `patch.operations.${index}.panel`))
          local.push({ ...i, opIndex: index });
        if (panels.size >= 200) add("PANEL_LIMIT", "panel", "document already has 200 panels");
        if (!local.length) {
          panels.set(op.panel.panelId, op.panel);
          inverse.unshift({ op: "removePanel", panelId: op.panel.panelId });
        }
        break;
      }
      case "updatePanel": {
        const prev = panels.get(op.panelId);
        if (!prev) add("PANEL_NOT_FOUND", "panelId", "panel does not exist");
        if (op.panel.panelId !== op.panelId)
          add("SCHEMA_INVALID", "panel.panelId", "panel.panelId must equal panelId");
        for (const i of panelSemanticIssues(op.panel, ctx, `patch.operations.${index}.panel`))
          local.push({ ...i, opIndex: index });
        if (!local.length && prev) {
          panels.set(op.panelId, op.panel);
          inverse.unshift({ op: "updatePanel", panelId: op.panelId, panel: prev });
        }
        break;
      }
      case "movePanel": {
        const prev = panels.get(op.panelId);
        if (!prev) add("PANEL_NOT_FOUND", "panelId", "panel does not exist");
        else {
          panels.set(op.panelId, { ...prev, layout: op.layout });
          inverse.unshift({ op: "movePanel", panelId: op.panelId, layout: prev.layout });
        }
        break;
      }
      case "removePanel": {
        const prev = panels.get(op.panelId);
        if (!prev) add("PANEL_NOT_FOUND", "panelId", "panel does not exist");
        else if ([...markers.values()].some((m) => m.panelId === op.panelId) || selections.has(op.panelId))
          add(
            "PANEL_HAS_DEPENDENTS",
            "panelId",
            "panel has markers or an active selection; remove them first",
          );
        else {
          panels.delete(op.panelId);
          inverse.unshift({ op: "addPanel", panel: prev });
        }
        break;
      }
      case "addMarker": {
        const m = op.marker;
        if (markers.has(m.markerId)) add("DUPLICATE_MARKER_ID", "marker.markerId", "markerId already exists");
        if (!panels.has(m.panelId)) add("PANEL_NOT_FOUND", "marker.panelId", "marker panel does not exist");
        const bad = anchorIssue(m);
        if (bad) add("MARKER_ANCHOR_INVALID", "marker.anchor", bad);
        if (!local.length) {
          markers.set(m.markerId, m);
          inverse.unshift({ op: "removeMarker", markerId: m.markerId });
        }
        break;
      }
      case "removeMarker": {
        const prev = markers.get(op.markerId);
        if (!prev) add("MARKER_NOT_FOUND", "markerId", "marker does not exist");
        else {
          markers.delete(op.markerId);
          inverse.unshift({ op: "addMarker", marker: prev });
        }
        break;
      }
      case "setSelection": {
        const s = op.selection;
        const p = panels.get(s.panelId);
        if (!p) add("PANEL_NOT_FOUND", "selection.panelId", "selection panel does not exist");
        else if (p.queryRef.hash !== s.queryHash || p.queryRef.semanticVersion !== s.semanticVersion)
          add(
            "SELECTION_MISMATCH",
            "selection.queryHash",
            "selection does not match the panel's current query",
          );
        if (Date.parse(s.interval.start) > Date.parse(s.interval.end))
          add("SCHEMA_INVALID", "selection.interval", "interval start is after end");
        if (!local.length) {
          const prev = selections.get(s.panelId);
          selections.set(s.panelId, s);
          inverse.unshift(
            prev ? { op: "setSelection", selection: prev } : { op: "clearSelection", panelId: s.panelId },
          );
        }
        break;
      }
      case "clearSelection": {
        const prev = selections.get(op.panelId);
        if (!prev) add("PANEL_NOT_FOUND", "panelId", "no selection for panel");
        else {
          selections.delete(op.panelId);
          inverse.unshift({ op: "setSelection", selection: prev });
        }
        break;
      }
    }
    opReports.push({ index, op: op.op, ok: local.length === 0, issues: local });
    issues.push(...local);
  });

  const next = normalizeDocument({
    ...doc,
    panels: [...panels.values()],
    markers: [...markers.values()],
    activeSelections: [...selections.values()],
  });
  return { report: { ok: issues.length === 0, issues, operations: opReports }, doc: next, inverse };
}

/**
 * Pure atomic apply (C11): either every operation applies and documentRevision increments by exactly one, or nothing
 * changes and the per-operation report is returned. `dataRevision` is never touched by a patch (C18).
 */
export function applyCanvasPatch(
  doc: CanvasDocument,
  patch: unknown,
  opts: { now: string; ctx?: ValidationContext },
): ApplyResult | (PatchReport & { ok: false }) {
  const report = validateCanvasPatchSemantics(doc, patch, opts.ctx);
  if (!report.ok) return { ...report, ok: false };
  const p = patch as CanvasPatch;
  return applyOps(doc, p.operations, { now: opts.now, ctx: opts.ctx, expectedRevision: p.expectedRevision });
}

/** Applies local ops (used for undo/redo of a recorded inverse). Same atomicity and revision rules. */
export function applyOps(
  doc: CanvasDocument,
  ops: readonly Op[],
  opts: { now: string; ctx?: ValidationContext; expectedRevision?: number },
): ApplyResult | (PatchReport & { ok: false }) {
  const exec = findExecutableContent(ops, "ops");
  if (exec.length) return { ok: false, issues: exec, operations: [] };
  const sim = simulate(doc, ops, opts.ctx ?? {}, opts.expectedRevision ?? null);
  if (!sim.report.ok) return { ...sim.report, ok: false };
  const document = CanvasDocument.parse({
    ...sim.doc,
    documentRevision: doc.documentRevision + 1,
    updatedAt: opts.now,
  });
  return { ok: true, document, inverse: sim.inverse, previewHash: previewHash(doc, ops) };
}

/** Stable hash of (base revision, operations, resulting content) — identical for repeated previews (C11a). */
export function previewHash(doc: CanvasDocument, ops: readonly Op[]): string {
  return hashCanonical({ base: documentContentHash(doc), revision: doc.documentRevision, ops });
}

/** Content hash of a document excluding volatile timestamps; used for state equality checks (C04, C06, C15). */
export function documentContentHash(doc: CanvasDocument): string {
  const n = normalizeDocument(doc);
  return hashCanonical({
    id: n.id,
    workspaceId: n.workspaceId,
    branchId: n.branchId,
    documentRevision: n.documentRevision,
    viewport: n.viewport,
    layoutMode: n.layoutMode,
    panels: n.panels,
    markers: n.markers,
    activeSelections: n.activeSelections,
  });
}

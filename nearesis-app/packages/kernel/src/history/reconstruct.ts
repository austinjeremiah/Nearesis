import { applyCanvasPatch } from "@nearesis/canvas-schema";
import type { CanvasDocument, CanvasPatch, PanelSpec } from "@nearesis/contracts";
import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import type { ObjectMap } from "./snapshots.ts";
import { hashOf } from "./snapshots.ts";

/**
 * Event-log reconstruction (ch.10 "Event-sourced command path", ch.09 "Playback"; 16b W11). The state of the canvas
 * and the evidence graph at revision N (= journal sequence number N) is rebuilt by replaying the append-only journal
 * from nothing. History is never rewritten: corrections are later compensating events and are replayed like any other.
 */

/** Event `change` markers that mutate evidence state and that this replayer understands. */
const REPLAYABLE = new Set([
  "graph.node_added",
  "graph.edge_added",
  "graph.node_data_updated",
  "graph.correction",
  "graph.semantic_version_changed",
]);
/** Markers that change state the replayer cannot rebuild: reported, and they forbid `exactReproduction: true`. */
const STATE_CHANGING_UNREPLAYABLE = new Set([
  "graph.node_restriction",
  "retention.payload_deleted",
  "graph.recheck_resolved",
]);

interface MergedValue {
  kind: string;
  label: string;
  data?: unknown;
  semanticPins?: unknown;
  tombstone?: boolean;
  rawObjectHash?: string;
}
/** One object change recorded by a merge event (`replay.objects`). */
interface MergedObject {
  objectId: string;
  entry: { op: "set" | "delete"; value?: unknown };
}

export type PanelDataState = "pinned" | "vintage_unavailable";

export interface ReconstructedPanel {
  panelId: string;
  dataState: PanelDataState;
  snapshotId: string | null;
  /** Data captured at the pinned snapshot, if it recorded any. Never today's data. */
  data: unknown;
}

export interface Reconstruction {
  workspaceId: string;
  revision: number;
  historical: true;
  eventsApplied: Array<{ seq: number; type: string; payloadHash: string }>;
  unreplayableEvents: Array<{ seq: number; change: string }>;
  canvas: { documentRevision: number; panels: PanelSpec[]; hash: string };
  graph: { nodes: Record<string, unknown>; edges: Record<string, unknown>; hash: string };
  objects: ObjectMap;
  stateHash: string;
  panels: ReconstructedPanel[];
  pinnedSnapshotId: string | null;
  unavailableSnapshotIds: string[];
  affectedPanelIds: string[];
  exactReproduction: boolean;
  notice: string;
}

export const canvasStateHash = (documentRevision: number, panels: PanelSpec[]): string =>
  hashOf({ documentRevision, panels: [...panels].sort((a, b) => a.panelId.localeCompare(b.panelId)) });

/** The oracle and the replayer share this shape, so equality means the same state, not the same code path. */
export function stateHashOf(objects: ObjectMap, documentRevision: number, panels: PanelSpec[]): string {
  const evidence = Object.fromEntries(Object.entries(objects).filter(([k]) => !k.startsWith("panel:")));
  return hashOf({ evidence, canvas: canvasStateHash(documentRevision, panels) });
}

interface EventRow {
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  payload_hash: string;
}

const emptyCanvas = (workspaceId: string, branchId: string): CanvasDocument =>
  ({
    id: "00000000-0000-4000-8000-000000000000",
    workspaceId,
    branchId,
    documentRevision: 0,
    dataRevision: 0,
    viewport: { zoom: 1, x: 0, y: 0 },
    layoutMode: "grid",
    panels: [],
    markers: [],
    activeSelections: [],
    updatedAt: new Date(0).toISOString(),
  }) as CanvasDocument;

export class ReconstructOps {
  constructor(private readonly db: Db) {}

  private tenant(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId, actorKind: s.principal.kind };
  }

  async reconstruct(session: Session, workspaceId: string, revision: number): Promise<Reconstruction> {
    return this.db.tx(this.tenant(session), (tx) => this.build(tx, workspaceId, revision));
  }

  async build(tx: Tx, workspaceId: string, revision: number): Promise<Reconstruction> {
    const ws = (
      await tx.query<{ active_branch_id: string }>("SELECT active_branch_id FROM workspaces WHERE id = $1", [
        workspaceId,
      ])
    ).rows[0];
    if (!ws) throw noWorkspaceAccess();
    const maxSeq = Number(
      (
        await tx.query("SELECT coalesce(max(seq),0) AS m FROM workspace_events WHERE workspace_id = $1", [
          workspaceId,
        ])
      ).rows[0].m,
    );
    if (!Number.isInteger(revision) || revision < 0 || revision > maxSeq)
      throw new KernelError("NOT_FOUND", "REVISION_NOT_FOUND", "No such revision.");
    const events = (
      await tx.query<EventRow>(
        `SELECT seq, event_type, payload, payload_hash FROM workspace_events
          WHERE workspace_id = $1 AND seq <= $2 ORDER BY seq`,
        [workspaceId, revision],
      )
    ).rows;

    // Canvas: replay the exact patches named by the canvas.patched events up to this revision.
    const opIds = events.flatMap((e) =>
      e.event_type === "canvas.patched"
        ? [String(e.payload.operationId)]
        : e.payload.change === "merge.accepted" &&
            (e.payload.replay as { canvasOperationId?: string } | null)?.canvasOperationId
          ? [String((e.payload.replay as { canvasOperationId: string }).canvasOperationId)]
          : [],
    );
    let doc = emptyCanvas(workspaceId, ws.active_branch_id);
    if (opIds.length) {
      const patches = (
        await tx.query<{ patch: CanvasPatch }>(
          "SELECT patch FROM canvas_patches WHERE workspace_id = $1 AND operation_id = ANY($2::uuid[]) ORDER BY revision",
          [workspaceId, opIds],
        )
      ).rows;
      for (const r of patches) {
        const res = applyCanvasPatch(doc, r.patch, { now: new Date(0).toISOString() });
        if (!res.ok)
          throw new KernelError(
            "DOMAIN_INVARIANT",
            "REPLAY_FAILED",
            "A recorded canvas patch no longer applies.",
          );
        doc = res.document;
      }
    }

    // Evidence graph: replay node, edge, data, correction and semantic-version events.
    const nodes = new Map<string, Record<string, unknown>>();
    const edges = new Map<string, Record<string, unknown>>();
    const versions = new Map<string, string>();
    const unreplayable: Array<{ seq: number; change: string }> = [];
    for (const e of events) {
      const change = typeof e.payload.change === "string" ? e.payload.change : "";
      if (change === "merge.accepted") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mp = e.payload as Record<string, any>;
        if (mp.target === "branch") continue; // a merge into a branch does not change main
        if (!mp.replay) {
          unreplayable.push({ seq: e.seq, change }); // recorded before merges carried their changes
          continue;
        }
        for (const o of mp.replay.objects as MergedObject[]) {
          const i = o.objectId.indexOf(":");
          const kind = o.objectId.slice(0, i);
          const rest = o.objectId.slice(i + 1);
          if (kind === "node") {
            if (o.entry.op === "delete") {
              const n = nodes.get(rest);
              if (n) n.tombstone = true;
            } else {
              const v = o.entry.value as MergedValue;
              nodes.set(rest, {
                kind: v.kind,
                label: v.label,
                data: v.data ?? {},
                semanticPins: v.semanticPins ?? {},
                tombstone: v.tombstone ?? false,
                ...(v.rawObjectHash ? { rawObjectHash: v.rawObjectHash } : {}),
              });
            }
          } else if (kind === "edge") {
            if (o.entry.op === "delete") edges.delete(o.objectId);
            else
              edges.set(o.objectId, {
                relation: (o.entry.value as { relation: string }).relation,
                reason: (o.entry.value as { reason?: string | null }).reason ?? null,
              });
          } else if (kind === "metric" && o.entry.op === "set")
            versions.set(rest, (o.entry.value as { version: string }).version);
        }
        continue;
      }
      if (STATE_CHANGING_UNREPLAYABLE.has(change)) {
        unreplayable.push({ seq: e.seq, change });
        continue;
      }
      if (!REPLAYABLE.has(change)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pl = e.payload as Record<string, any>;
      if (change === "graph.node_added") {
        const n = pl.node;
        nodes.set(pl.nodeId, {
          kind: n.kind,
          label: n.label,
          data: n.data,
          semanticPins: n.semanticPins,
          tombstone: false,
          ...(n.rawObjectHash ? { rawObjectHash: n.rawObjectHash } : {}),
        });
      } else if (change === "graph.edge_added") {
        for (const t of pl.tombstones ?? [])
          if (!nodes.has(t.id))
            nodes.set(t.id, {
              kind: t.kind,
              label: `TOMBSTONE ${String(t.id).slice(0, 8)}`,
              data: {},
              semanticPins: {},
              tombstone: true,
            });
        edges.set(`edge:${pl.edge.from}|${pl.edge.to}|${pl.edge.relation}`, {
          relation: pl.edge.relation,
          reason: pl.edge.reason,
        });
      } else if (change === "graph.node_data_updated") {
        const n = nodes.get(pl.nodeId);
        if (n) n.data = { ...(n.data as object), ...pl.patch };
      } else if (change === "graph.correction") {
        const n = nodes.get(pl.nodeId);
        if (n) {
          if (pl.patch?.label) n.label = pl.patch.label;
          if (pl.patch?.data) n.data = { ...(n.data as object), ...pl.patch.data };
        }
      } else if (change === "graph.semantic_version_changed") versions.set(pl.metricId, pl.toVersion);
    }
    const objects: ObjectMap = {};
    for (const p of doc.panels) objects[`panel:${p.panelId}`] = p;
    for (const [id, n] of nodes) objects[`node:${id}`] = n;
    for (const [k, v] of edges) objects[k] = v;
    for (const [m, v] of versions) objects[`metric:${m}`] = { version: v };

    // Data vintage: the latest snapshot at or before this revision. If it (or any snapshot) is unavailable the panels
    // say so; an older snapshot is never substituted silently, and current data is never shown.
    const snap = (
      await tx.query<{ id: string; payload: { panelResults?: Record<string, { result: unknown }> } | null }>(
        `SELECT id, payload FROM history_snapshots
          WHERE workspace_id = $1 AND branch_id = $2 AND event_seq <= $3 ORDER BY event_seq DESC, created_at DESC LIMIT 1`,
        [workspaceId, ws.active_branch_id, revision],
      )
    ).rows[0];
    const panels: ReconstructedPanel[] = doc.panels.map((p) => {
      const rec = snap?.payload?.panelResults?.[p.panelId];
      return rec
        ? { panelId: p.panelId, dataState: "pinned", snapshotId: snap!.id, data: rec.result }
        : { panelId: p.panelId, dataState: "vintage_unavailable", snapshotId: snap?.id ?? null, data: null };
    });
    const affected = panels.filter((p) => p.dataState === "vintage_unavailable").map((p) => p.panelId);
    const unavailableSnapshotIds = snap && !snap.payload ? [snap.id] : [];
    const exact = affected.length === 0 && unreplayable.length === 0;
    const canvasHash = canvasStateHash(doc.documentRevision, doc.panels);
    const graphObjs = {
      nodes: Object.fromEntries([...nodes]),
      edges: Object.fromEntries([...edges]),
    };
    return {
      workspaceId,
      revision,
      historical: true,
      eventsApplied: events.map((e) => ({ seq: e.seq, type: e.event_type, payloadHash: e.payload_hash })),
      unreplayableEvents: unreplayable,
      canvas: { documentRevision: doc.documentRevision, panels: doc.panels, hash: canvasHash },
      graph: { ...graphObjs, hash: hashOf({ ...graphObjs, versions: Object.fromEntries(versions) }) },
      objects,
      stateHash: stateHashOf(objects, doc.documentRevision, doc.panels),
      panels,
      pinnedSnapshotId: snap?.id ?? null,
      unavailableSnapshotIds,
      affectedPanelIds: affected,
      exactReproduction: exact,
      notice: exact
        ? "Exact reproduction: every panel is pinned to a recorded data vintage."
        : "NOT an exact reproduction: panels marked vintage_unavailable have no recoverable data vintage; current data is not substituted.",
    };
  }

  /** Exportable reconstruction file with a content hash that re-verifies. */
  async exportFile(session: Session, workspaceId: string, revision: number) {
    const r = await this.reconstruct(session, workspaceId, revision);
    const body = {
      format: "nearesis.reconstruction.v1",
      workspaceId,
      revision,
      eventsApplied: r.eventsApplied,
      unreplayableEvents: r.unreplayableEvents,
      snapshotIds: r.pinnedSnapshotId ? [r.pinnedSnapshotId] : [],
      unavailableSnapshotIds: r.unavailableSnapshotIds,
      affectedPanels: r.affectedPanelIds,
      exactReproduction: r.exactReproduction,
      notice: r.notice,
      canvasHash: r.canvas.hash,
      graphHash: r.graph.hash,
      stateHash: r.stateHash,
    };
    return { ...body, contentHash: hashOf(body) };
  }
}

/** Recompute a reconstruction file's content hash; false if anything in it was altered. */
export function verifyReconstructionFile(file: { contentHash: string } & Record<string, unknown>): boolean {
  const { contentHash, ...body } = file;
  return hashOf(body) === contentHash;
}

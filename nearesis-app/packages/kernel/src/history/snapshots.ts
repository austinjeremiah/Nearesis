import { canonicalJson, sha256Hex } from "@nearesis/plugin-sdk";
import type { CanvasDocument, DataVintage, GraphProjection, ObjectChange } from "@nearesis/contracts";
import { CreateSnapshotRequest, PurgeSnapshotRequest } from "@nearesis/contracts";
import { canAdmin } from "../auth.ts";
import type { Session } from "../auth.ts";
import type { CanvasService } from "../canvas.ts";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { IntegrityGuard } from "../integrity.ts";
import type { EvidenceGraphService } from "../graph.ts";
import { noWorkspaceAccess } from "../workspace.ts";
import { HistoryRunner, idFor, parseBody } from "./runner.ts";
import { capturePanelResults, panelResultsHash, panelCacheKey } from "./pinned.ts";
import type { PanelExecutor, PanelResults } from "./pinned.ts";
import type { CommandOpts } from "./graph-ops.ts";

export type ObjectMap = Record<string, unknown>;

/** Stable content hash of any JSON value; absent objects hash as `null`. */
export const hashOf = (v: unknown): string => sha256Hex(canonicalJson(v ?? null));

/**
 * The semantic objects of a workspace branch, keyed `panel:<id>`, `node:<id>`, `edge:<from>|<to>|<rel>`,
 * `metric:<id>`. Layout (node positions, viewport) is deliberately not part of this map: layout is not evidence.
 */
export async function captureLiveObjects(
  tx: Tx,
  workspaceId: string,
  branchId: string | null,
): Promise<ObjectMap> {
  const objects: ObjectMap = {};
  const panels = await tx.query<{ id: string; spec: unknown }>(
    `SELECT ps.id, ps.spec FROM panel_specs ps JOIN canvas_documents d ON d.id = ps.document_id
      WHERE ps.workspace_id = $1 AND d.branch_id IS NOT DISTINCT FROM $2 AND ps.removed_at IS NULL ORDER BY ps.id`,
    [workspaceId, branchId],
  );
  for (const p of panels.rows) objects[`panel:${p.id}`] = p.spec;
  const nodes = await tx.query<{
    id: string;
    kind: string;
    label: string;
    data: unknown;
    semantic_pins: unknown;
    tombstone: boolean;
    raw_object_hash: string | null;
  }>(
    "SELECT id, kind, label, data, semantic_pins, tombstone, raw_object_hash FROM evidence_nodes WHERE workspace_id = $1 ORDER BY id",
    [workspaceId],
  );
  for (const n of nodes.rows)
    objects[`node:${n.id}`] = {
      kind: n.kind,
      label: n.label,
      data: n.data,
      semanticPins: n.semantic_pins,
      tombstone: n.tombstone,
      ...(n.raw_object_hash ? { rawObjectHash: n.raw_object_hash } : {}),
    };
  const edges = await tx.query<{
    from_node: string;
    to_node: string;
    relation: string;
    reason: string | null;
  }>(
    "SELECT from_node, to_node, relation, reason FROM evidence_edges WHERE workspace_id = $1 ORDER BY from_node, to_node, relation",
    [workspaceId],
  );
  for (const e of edges.rows)
    objects[`edge:${e.from_node}|${e.to_node}|${e.relation}`] = { relation: e.relation, reason: e.reason };
  for (const [m, v] of Object.entries(await currentSemanticVersions(tx, workspaceId)))
    objects[`metric:${m}`] = { version: v };
  return objects;
}

export async function currentSemanticVersions(tx: Tx, workspaceId: string): Promise<Record<string, string>> {
  const r = await tx.query<{ metric_id: string; version: string }>(
    `SELECT DISTINCT ON (metric_id) metric_id, version FROM semantic_versions
      WHERE workspace_id = $1 ORDER BY metric_id, seq DESC`,
    [workspaceId],
  );
  return Object.fromEntries(r.rows.map((x) => [x.metric_id, x.version]));
}

export function diffObjects(before: ObjectMap, after: ObjectMap): ObjectChange[] {
  const out: ObjectChange[] = [];
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[id];
    const a = after[id];
    if (b === undefined) out.push({ objectId: id, change: "added", after: a });
    else if (a === undefined) out.push({ objectId: id, change: "removed", before: b });
    else if (hashOf(a) !== hashOf(b)) out.push({ objectId: id, change: "changed", before: b, after: a });
  }
  return out.sort((x, y) => x.objectId.localeCompare(y.objectId));
}

export interface SnapshotPayload {
  canvas: CanvasDocument;
  graph: GraphProjection;
  /** Layout is stored beside, never inside, the evidence semantics. */
  layout: Record<string, { x: number; y: number }>;
  objects: ObjectMap;
  /** Results captured at finalization for data-pinned snapshots (W10). Part of the content hash when present. */
  panelResults?: PanelResults;
}

/** Content hash of a snapshot: semantic content only (never capture time), plus captured panel results when present. */
export function snapshotContentHash(payload: SnapshotPayload, semanticPins: Record<string, string>): string {
  const base = {
    objects: payload.objects,
    canvas: { ...payload.canvas, updatedAt: undefined },
    semanticPins,
  };
  return hashOf(
    payload.panelResults ? { ...base, panelResults: panelResultsHash(payload.panelResults) } : base,
  );
}

export interface SnapshotRow {
  id: string;
  workspaceId: string;
  branchId: string;
  label: string;
  contentHash: string;
  createdAt: string;
  createdBy: string;
  dataVintage: DataVintage;
}

interface SnapRowRaw {
  id: string;
  workspace_id: string;
  branch_id: string;
  label: string;
  content_hash: string;
  created_at: Date | string;
  created_by: string;
  data_vintage: DataVintage;
}

function rowToSummary(r: SnapRowRaw): SnapshotRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    branchId: r.branch_id,
    label: r.label,
    contentHash: r.content_hash,
    createdAt: new Date(r.created_at).toISOString(),
    createdBy: r.created_by,
    dataVintage: r.data_vintage,
  };
}

const SNAP_COLS =
  "id, workspace_id, branch_id, label, content_hash, created_at, created_by, data_vintage, document_revision, data_revision";

export class SnapshotOps {
  private readonly integrity: IntegrityGuard;
  constructor(
    private readonly db: Db,
    private readonly runner: HistoryRunner,
    private readonly canvas: CanvasService,
    private readonly graph: EvidenceGraphService,
  ) {
    this.integrity = new IntegrityGuard(db);
  }

  private tenant(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId };
  }

  /** Capture workspace state, pin data and semantic versions. Immutable once written. */
  async create(
    session: Session,
    workspaceId: string,
    body: unknown,
    opts: CommandOpts & { executor?: PanelExecutor } = {},
  ) {
    const p = parseBody(CreateSnapshotRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "snapshot.create",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        const { tx, workspace } = ctx;
        const branchId = workspace.activeBranchId;
        if (!branchId)
          throw new KernelError("DOMAIN_INVARIANT", "NO_ACTIVE_BRANCH", "Workspace has no active branch.");
        const id = p.snapshotId ?? idFor(ctx.commandId, "snapshot");
        const seq = (
          await tx.query<{ seq: number }>(
            "SELECT coalesce(max(seq), 0) AS seq FROM workspace_events WHERE workspace_id = $1",
            [workspace.id],
          )
        ).rows[0]!.seq;
        const loaded = await this.canvas.load(tx, workspace.id, branchId);
        const canvas: CanvasDocument =
          loaded ??
          ({
            id: idFor(workspace.id, "canvas"),
            workspaceId: workspace.id,
            branchId,
            documentRevision: 0,
            dataRevision: 0,
            viewport: { zoom: 1, x: 0, y: 0 },
            layoutMode: "grid",
            panels: [],
            markers: [],
            activeSelections: [],
            updatedAt: new Date(0).toISOString(),
          } as CanvasDocument);
        const graphProj = await this.graph.projectIn(tx, workspace.id, workspace.version, branchId);
        const layout: SnapshotPayload["layout"] = {};
        for (const n of graphProj.nodes) {
          if (n.position) layout[n.id] = n.position;
          delete n.position;
        }
        const objects = await captureLiveObjects(tx, workspace.id, branchId);
        const payload: SnapshotPayload = { canvas, graph: graphProj, layout, objects };
        const semanticPins = await currentSemanticVersions(tx, workspace.id);
        if (opts.executor) {
          // A data-pinned snapshot needs a watermark for every source its panels read; nothing is filled with now().
          payload.panelResults = await capturePanelResults(
            opts.executor,
            canvas.panels,
            p.sourceSnapshot?.watermark ?? null,
            semanticPins,
            p.sourceSnapshot?.manifestHash ?? null,
          );
        }
        const vintage: DataVintage = {
          capturedAt: new Date().toISOString(),
          workspaceVersion: workspace.version,
          eventSeq: seq,
          documentRevision: canvas.documentRevision,
          dataRevision: canvas.dataRevision,
          sourceSnapshot: p.sourceSnapshot ?? null,
          semanticPins,
        };
        // The hash covers the semantic content only (not capture time), so identical state hashes identically.
        const contentHash = snapshotContentHash(payload, semanticPins);
        await tx.query(
          `INSERT INTO history_snapshots(id, org_id, workspace_id, branch_id, label, event_seq, workspace_version,
             document_revision, data_revision, content_hash, payload, data_vintage, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id,
            workspace.orgId,
            workspace.id,
            branchId,
            p.label,
            seq,
            workspace.version,
            canvas.documentRevision,
            canvas.dataRevision,
            contentHash,
            JSON.stringify(payload),
            JSON.stringify(vintage),
            ctx.session.userId,
          ],
        );
        return {
          eventType: "snapshot.finalized",
          data: { snapshotId: id, label: p.label, contentHash, documentRevision: canvas.documentRevision },
          result: { snapshotId: id, contentHash, documentRevision: canvas.documentRevision },
        };
      },
    });
  }

  async list(session: Session, workspaceId: string): Promise<SnapshotRow[]> {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      const r = await tx.query(
        `SELECT ${SNAP_COLS} FROM history_snapshots WHERE workspace_id = $1 ORDER BY created_at, id`,
        [workspaceId],
      );
      return r.rows.map(rowToSummary);
    });
  }

  private need(p: SnapshotPayload | null): SnapshotPayload {
    if (!p)
      throw new KernelError(
        "NOT_FOUND",
        "VINTAGE_UNAVAILABLE",
        "This snapshot's payload was removed by a retention purge.",
      );
    return p;
  }

  /** Retention purge: payload removed, identity and content hash kept, never silently replaced by anything else. */
  async purge(session: Session, workspaceId: string, body: unknown, opts: CommandOpts = {}) {
    const p = parseBody(PurgeSnapshotRequest, body);
    return this.runner.run(session, workspaceId, {
      commandType: "snapshot.purge",
      commandId: p.commandId,
      idempotencyKey: opts.idempotencyKey,
      expectedVersion: p.expectedVersion,
      payload: p,
      handle: async (ctx) => {
        if (!canAdmin(ctx.session.role))
          throw new KernelError(
            "FORBIDDEN",
            "INSUFFICIENT_ROLE",
            "Only an owner or admin may purge a snapshot.",
          );
        const r = await ctx.tx.query(
          `UPDATE history_snapshots SET payload = NULL, purged_at = now(), purge_reason = $3
            WHERE id = $1 AND workspace_id = $2 AND payload IS NOT NULL`,
          [p.snapshotId, ctx.workspace.id, p.reason],
        );
        if (!r.rowCount) throw new KernelError("NOT_FOUND", "SNAPSHOT_NOT_FOUND", "No purgeable snapshot.");
        return {
          eventType: "workspace.updated",
          data: { change: "snapshot.purged", snapshotId: p.snapshotId, reason: p.reason },
          result: { snapshotId: p.snapshotId, purged: true },
        };
      },
    });
  }

  private async assertWorkspace(tx: Tx, workspaceId: string): Promise<{ version: number }> {
    const w = (await tx.query("SELECT version FROM workspaces WHERE id = $1", [workspaceId])).rows[0];
    if (!w) throw noWorkspaceAccess();
    return w;
  }

  /** Load a snapshot row plus payload; unknown and foreign ids are indistinguishable (403 -> 404 at the edge). */
  async load(tx: Tx, workspaceId: string, snapshotId: string) {
    const r = (
      await tx.query(
        `SELECT ${SNAP_COLS}, org_id, payload FROM history_snapshots WHERE id = $1 AND workspace_id = $2`,
        [snapshotId, workspaceId],
      )
    ).rows[0];
    if (!r) throw noWorkspaceAccess();
    const row = rowToSummary(r);
    // Evidence integrity on the read path: the stored payload must still hash to the recorded content hash. A purged
    // payload (retention) has nothing left to verify; its identity and hash remain.
    if (r.payload) {
      const scope = { orgId: r.org_id as string, userId: null };
      const actual = snapshotContentHash(r.payload as SnapshotPayload, row.dataVintage.semanticPins);
      await this.integrity.verify(scope, "evidence_item", snapshotId, row.contentHash, actual);
    }
    return {
      row,
      /** Null once a retention purge removed the payload; the identity and content hash remain. */
      payload: (r.payload ?? null) as SnapshotPayload | null,
      documentRevision: r.document_revision as number,
    };
  }

  /** Historical reads are always labelled with their vintage and whether live data has moved on. */
  private async label(tx: Tx, workspaceId: string, row: SnapshotRow) {
    const cur = (
      await tx.query<{ revision: number; data_revision: number }>(
        `SELECT d.revision, d.data_revision FROM canvas_documents d
           WHERE d.workspace_id = $1 AND d.branch_id = (SELECT active_branch_id FROM workspaces WHERE id = $1)`,
        [workspaceId],
      )
    ).rows[0];
    const pins = await currentSemanticVersions(tx, workspaceId);
    const stale =
      (cur?.revision ?? 0) !== row.dataVintage.documentRevision ||
      (cur?.data_revision ?? 0) !== row.dataVintage.dataRevision ||
      canonicalJson(pins) !== canonicalJson(row.dataVintage.semanticPins);
    return {
      historical: true as const,
      snapshotId: row.id,
      label: row.label,
      capturedAt: row.dataVintage.capturedAt,
      dataVintage: row.dataVintage,
      stale,
      currentDocumentRevision: cur?.revision ?? 0,
    };
  }

  async view(
    session: Session,
    workspaceId: string,
    snapshotId: string,
    part: "canvas" | "graph" | "layout" | "all",
  ) {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      const { row, payload: p0 } = await this.load(tx, workspaceId, snapshotId);
      const payload = this.need(p0);
      const meta = await this.label(tx, workspaceId, row);
      const verified = snapshotContentHash(payload, row.dataVintage.semanticPins);
      const body: Partial<SnapshotPayload> =
        part === "canvas"
          ? { canvas: payload.canvas }
          : part === "graph"
            ? { graph: payload.graph, layout: payload.layout }
            : part === "layout"
              ? { layout: payload.layout }
              : payload;
      return { ...meta, contentHash: row.contentHash, integrityOk: verified === row.contentHash, ...body };
    });
  }

  async compare(session: Session, workspaceId: string, a: string, b: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      const x = await this.load(tx, workspaceId, a);
      const y = await this.load(tx, workspaceId, b);
      this.need(x.payload);
      this.need(y.payload);
      const pins = new Set([
        ...Object.keys(x.row.dataVintage.semanticPins),
        ...Object.keys(y.row.dataVintage.semanticPins),
      ]);
      const semanticPinChanges = [...pins]
        .map((m) => ({
          metricId: m,
          from: x.row.dataVintage.semanticPins[m] ?? null,
          to: y.row.dataVintage.semanticPins[m] ?? null,
        }))
        .filter((c) => c.from !== c.to);
      return {
        from: a,
        to: b,
        changes: diffObjects(x.payload!.objects, y.payload!.objects),
        documentRevision: { from: x.documentRevision, to: y.documentRevision },
        semanticPinChanges,
      };
    });
  }

  /**
   * Execute every panel of a finalized snapshot against its pinned watermark and semantic versions (never against live
   * data) and compare with what was captured at finalization.
   */
  async executePinned(session: Session, workspaceId: string, snapshotId: string, executor: PanelExecutor) {
    const { row, payload } = await this.db.tx(this.tenant(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      return this.load(tx, workspaceId, snapshotId);
    });
    if (!payload)
      throw new KernelError("NOT_FOUND", "VINTAGE_UNAVAILABLE", "Snapshot payload is unavailable.");
    const pin = {
      watermark: row.dataVintage.sourceSnapshot?.watermark ?? null,
      semanticVersions: row.dataVintage.semanticPins,
    };
    const captured = payload.panelResults ?? {};
    const out = [];
    for (const panel of payload.canvas.panels) {
      const result = await executor.execute(panel, pin);
      const resultHash = hashOf(result);
      out.push({
        panelId: panel.panelId,
        result,
        resultHash,
        capturedHash: captured[panel.panelId]?.resultHash ?? null,
        byteEqualToCaptured: captured[panel.panelId]?.resultHash === resultHash,
        metadata: {
          snapshotId,
          pinnedSemanticVersions: pin.semanticVersions,
          watermark: pin.watermark,
          cacheKey: panelCacheKey(panel.queryRef.hash, pin.semanticVersions, row.dataVintage.sourceSnapshot),
        },
      });
    }
    return out;
  }

  /** Execute the live canvas (current watermark, current semantic versions) for comparison with pinned results. */
  async executeLive(session: Session, workspaceId: string, executor: PanelExecutor) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const ws = (
        await tx.query<{ active_branch_id: string | null }>(
          "SELECT active_branch_id FROM workspaces WHERE id = $1",
          [workspaceId],
        )
      ).rows[0];
      if (!ws) throw noWorkspaceAccess();
      const doc = await this.canvas.load(tx, workspaceId, ws.active_branch_id!);
      const versions = await currentSemanticVersions(tx, workspaceId);
      const out = [];
      for (const panel of doc?.panels ?? []) {
        const result = await executor.execute(panel, { watermark: null, semanticVersions: versions });
        out.push({
          panelId: panel.panelId,
          result,
          resultHash: hashOf(result),
          metadata: {
            snapshotId: null,
            pinnedSemanticVersions: versions,
            watermark: null,
            cacheKey: panelCacheKey(panel.queryRef.hash, versions, null),
          },
        });
      }
      return out;
    });
  }

  /** Revision timeline: journal events, snapshots, branches, merges and semantic-version changes, oldest first. */
  async timeline(session: Session, workspaceId: string, limit = 500) {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.assertWorkspace(tx, workspaceId);
      const entries: Array<Record<string, unknown>> = [];
      const ev = await tx.query(
        `SELECT seq, event_type, actor_id, actor_kind, occurred_at, payload FROM workspace_events
          WHERE workspace_id = $1 ORDER BY seq DESC LIMIT $2`,
        [workspaceId, limit],
      );
      // Attribution for entries that come from tables rather than events: the event that created them says who did.
      const kindOf = new Map<string, string>();
      for (const e of ev.rows) {
        const pl = (e.payload ?? {}) as Record<string, unknown>;
        const ch = String(pl.change ?? "");
        if (e.event_type === "snapshot.finalized" && pl.snapshotId)
          kindOf.set(`snap:${pl.snapshotId}`, e.actor_kind);
        else if (ch === "branch.created") kindOf.set(`branch:${pl.branchId}`, e.actor_kind);
        else if (ch === "merge.proposed") kindOf.set(`merge:${pl.proposalId}:proposed`, e.actor_kind);
        else if (ch === "merge.accepted" || ch === "merge.rejected")
          kindOf.set(`merge:${pl.proposalId}:decided`, e.actor_kind);
        else if (ch === "graph.semantic_version_changed")
          kindOf.set(`semver:${pl.metricId}:${pl.toVersion}`, e.actor_kind);
      }
      const kind = (k: string): string => kindOf.get(k) ?? "human";
      for (const e of ev.rows)
        entries.push({
          actorKind: e.actor_kind,
          at: new Date(e.occurred_at).toISOString(),
          seq: e.seq,
          kind: "event",
          type: e.event_type,
          ref: null,
          actorId: e.actor_id,
          summary: String(e.payload?.change ?? e.payload?.commandType ?? e.event_type),
          documentRevision:
            typeof e.payload?.documentRevision === "number" ? e.payload.documentRevision : null,
        });
      const sn = await tx.query(
        `SELECT id, label, created_at, created_by, document_revision, event_seq FROM history_snapshots WHERE workspace_id = $1`,
        [workspaceId],
      );
      for (const s of sn.rows)
        entries.push({
          actorKind: kind(`snap:${s.id}`),
          at: new Date(s.created_at).toISOString(),
          seq: s.event_seq,
          kind: "snapshot",
          type: "snapshot.created",
          ref: s.id,
          actorId: s.created_by,
          summary: s.label,
          documentRevision: s.document_revision,
        });
      const br = await tx.query(
        `SELECT hb.branch_id, hb.name, hb.created_at, b.created_by FROM history_branches hb JOIN branches b ON b.id = hb.branch_id WHERE hb.workspace_id = $1`,
        [workspaceId],
      );
      for (const b of br.rows)
        entries.push({
          actorKind: kind(`branch:${b.branch_id}`),
          at: new Date(b.created_at).toISOString(),
          seq: null,
          kind: "branch",
          type: "branch.created",
          ref: b.branch_id,
          actorId: b.created_by,
          summary: `branch ${b.name}`,
          documentRevision: null,
        });
      const mp = await tx.query(
        "SELECT id, status, created_at, created_by, decided_at, decided_by FROM history_merge_proposals WHERE workspace_id = $1",
        [workspaceId],
      );
      for (const m of mp.rows) {
        entries.push({
          actorKind: kind(`merge:${m.id}:proposed`),
          at: new Date(m.created_at).toISOString(),
          seq: null,
          kind: "merge",
          type: "merge.proposed",
          ref: m.id,
          actorId: m.created_by,
          summary: "merge proposed",
          documentRevision: null,
        });
        if (m.decided_at)
          entries.push({
            actorKind: kind(`merge:${m.id}:decided`),
            at: new Date(m.decided_at).toISOString(),
            seq: null,
            kind: "merge",
            type: `merge.${m.status}`,
            ref: m.id,
            actorId: m.decided_by,
            summary: `merge ${m.status}`,
            documentRevision: null,
          });
      }
      const sv = await tx.query(
        "SELECT metric_id, seq, version, changed_by, changed_at FROM semantic_versions WHERE workspace_id = $1",
        [workspaceId],
      );
      for (const v of sv.rows)
        entries.push({
          actorKind: kind(`semver:${v.metric_id}:${v.version}`),
          at: new Date(v.changed_at).toISOString(),
          seq: null,
          kind: "semantic_version",
          type: "semantic_version.changed",
          ref: v.metric_id,
          actorId: v.changed_by,
          summary: `${v.metric_id} -> ${v.version}`,
          documentRevision: null,
        });
      entries.sort(
        (a, b) => String(a.at).localeCompare(String(b.at)) || Number(a.seq ?? 0) - Number(b.seq ?? 0),
      );
      return entries;
    });
  }
}

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import type { CollabScope } from "@nearesis/contracts";
import { canWrite } from "../auth.ts";
import type { Session } from "../auth.ts";
import type { Db, Tx } from "../db/pool.ts";
import { KernelError } from "../errors.ts";
import { noWorkspaceAccess } from "../workspace.ts";

const MAX_UPDATE_BYTES = 1_500_000;
const MAX_LAYOUT_KEYS = 5000;
const MAX_NOTES_CHARS = 200_000;
const COORD = 1_000_000;
const PRESENCE_TTL_MS = 30_000;
/** Declared interval within which a connection of a revoked member is closed (16b W15(d)). */
export const REVOCATION_CLOSE_MS = 2_000;

/** Y root name per scope. A scope's room may contain only its own root; anything else is rejected. */
const ROOT: Record<CollabScope, string> = { layout: "layout", notes: "notes" };

interface PresenceEntry {
  userId: string;
  state: Record<string, unknown>;
  at: number;
}

export interface CollabFrame {
  type: "update" | "presence";
  scope: CollabScope;
  cursor?: number;
  update?: string;
  peers?: Array<{ userId: string; state: Record<string, unknown> }>;
}

/**
 * A live collaboration connection. Frames are delivered only while the member's access still checks out against the
 * database at delivery time; a periodic revalidation closes the connection when membership is revoked.
 */
export class CollabConnection {
  readonly frames: CollabFrame[] = [];
  closed = false;
  closedAt: number | null = null;
  closeReason: string | null = null;
  readonly opened = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private waiters: Array<() => void> = [];
  /** Push hooks for transports (the WebSocket server): called for every delivered frame and once on close. */
  onFrame: ((f: CollabFrame) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;

  constructor(
    readonly id: string,
    readonly session: Session,
    readonly workspaceId: string,
    readonly scope: CollabScope,
    private readonly svc: CollabService,
    private readonly onClose: (c: CollabConnection) => void,
    revalidateMs: number,
  ) {
    this.timer = setInterval(() => void this.revalidate(), revalidateMs);
    this.timer.unref();
  }

  /** Apply an update from this connection; the server re-authorises on every call and fans out to the room. */
  async send(b64: string): Promise<{ cursor: number }> {
    if (this.closed) throw new KernelError("FORBIDDEN", "CONNECTION_CLOSED", "The connection is closed.");
    try {
      const r = await this.svc.applyUpdate(this.session, this.workspaceId, this.scope, b64);
      await this.svc.broadcast(this, { type: "update", scope: this.scope, cursor: r.cursor, update: b64 });
      return r;
    } catch (e) {
      if (e instanceof KernelError && e.reasonCode === "ACCESS_DENIED") this.close("revoked");
      throw e;
    }
  }

  async setPresence(state: Record<string, unknown>) {
    if (this.closed) throw new KernelError("FORBIDDEN", "CONNECTION_CLOSED", "The connection is closed.");
    await this.svc.setPresence(this.session, this.workspaceId, this.scope, this.id, state);
    await this.svc.broadcast(this, {
      type: "presence",
      scope: this.scope,
      peers: (await this.svc.listPresence(this.session, this.workspaceId, this.scope)).peers.map((p) => ({
        userId: p.userId,
        state: p.state,
      })),
    });
  }

  /** @internal delivery from the hub */
  deliver(f: CollabFrame) {
    if (this.closed) return;
    this.frames.push(f);
    for (const w of this.waiters.splice(0)) w();
    this.onFrame?.(f);
  }

  async revalidate(): Promise<boolean> {
    if (this.closed) return false;
    const ok = await this.svc.stillAuthorised(this.session, this.workspaceId);
    if (!ok) this.close("revoked");
    return ok;
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.closedAt = Date.now();
    this.closeReason = reason;
    if (this.timer) clearInterval(this.timer);
    this.onClose(this);
    for (const w of this.waiters.splice(0)) w();
    this.onClosed?.(reason);
  }
}

const bad = (reason: string, msg: string) => new KernelError("VALIDATION_FAILED", reason, msg);

/**
 * Scoped Yjs collaboration for layout and notes (ch.09). The server is authoritative: membership is checked through
 * RLS on every call, writers need a write role, and every update is validated against a scratch document before it is
 * persisted or served, so a CRDT peer cannot smuggle evidence semantics or oversized content. Updates are persisted in
 * `collab_updates` (durable, tenant-isolated); presence is ephemeral in-process state, only ever returned to callers
 * who passed the same membership check for that exact workspace.
 */
export class CollabService {
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();
  private readonly rooms = new Map<string, Set<CollabConnection>>();

  constructor(private readonly db: Db) {}

  /** Does this session still pass the workspace access check (membership, RLS, not archived)? */
  async stillAuthorised(session: Session, workspaceId: string): Promise<boolean> {
    try {
      await this.db.tx(this.tenant(session), (tx) => this.access(tx, workspaceId));
      return true;
    } catch (e) {
      if (e instanceof KernelError) return false;
      throw e;
    }
  }

  /** Open a connection to a scoped room. Fails identically for unknown and foreign workspaces. */
  async connect(
    session: Session,
    workspaceId: string,
    scope: CollabScope,
    opts: { revalidateMs?: number } = {},
  ): Promise<CollabConnection> {
    await this.db.tx(this.tenant(session), (tx) => this.access(tx, workspaceId));
    const key = `${workspaceId}:${scope}`;
    const conn = new CollabConnection(
      randomUUID(),
      session,
      workspaceId,
      scope,
      this,
      (c) => {
        this.rooms.get(key)?.delete(c);
        const room = this.presence.get(key);
        if (room)
          for (const k of [...room.keys()])
            if (k.startsWith(`${c.session.userId}:${c.id.slice(0, 64)}`)) room.delete(k);
      },
      opts.revalidateMs ?? 500,
    );
    const set = this.rooms.get(key) ?? new Set();
    set.add(conn);
    this.rooms.set(key, set);
    return conn;
  }

  /** Fan a frame out to the other connections of the same room, each re-authorised at delivery time. */
  async broadcast(from: CollabConnection, f: CollabFrame): Promise<void> {
    const room = this.rooms.get(`${from.workspaceId}:${from.scope}`);
    if (!room) return;
    for (const c of [...room]) {
      if (c === from || c.closed) continue;
      if (await this.stillAuthorised(c.session, c.workspaceId)) c.deliver(f);
      else c.close("revoked");
    }
  }

  /**
   * Reconcile the CRDT layout with the canvas as recorded by the event log. The canvas is authoritative for which
   * panels exist: a layout entry whose panel is gone (deleted, even if a collaborator moved it concurrently) is
   * dropped and a notice is recorded. A panel without a layout entry keeps no position (the client lays it out).
   */
  async reconcileLayout(session: Session, workspaceId: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const ws = await this.access(tx, workspaceId);
      const doc = await this.load(tx, workspaceId, "layout");
      const crdt = Object.fromEntries(doc.getMap<unknown>("layout").entries()) as Record<
        string,
        { x: number; y: number }
      >;
      const canvas = (
        await tx.query<{ revision: number }>(
          `SELECT d.revision FROM canvas_documents d JOIN workspaces w ON w.id = d.workspace_id AND w.active_branch_id = d.branch_id
            WHERE d.workspace_id = $1`,
          [workspaceId],
        )
      ).rows[0];
      const panels = (
        await tx.query<{ id: string }>(
          `SELECT ps.id FROM panel_specs ps JOIN canvas_documents d ON d.id = ps.document_id
            WHERE ps.workspace_id = $1 AND ps.removed_at IS NULL AND d.branch_id = (SELECT active_branch_id FROM workspaces WHERE id = $1)`,
          [workspaceId],
        )
      ).rows.map((p) => p.id);
      const live = new Set(panels);
      const dropped = Object.keys(crdt).filter((k) => !live.has(k));
      const layout = Object.fromEntries(Object.entries(crdt).filter(([k]) => live.has(k)));
      if (dropped.length)
        await tx.query(
          "INSERT INTO collab_notices(org_id, workspace_id, scope, kind, detail) VALUES ($1,$2,'layout','dangling_layout_entry_dropped',$3)",
          [ws.orgId, workspaceId, JSON.stringify({ dropped, documentRevision: canvas?.revision ?? 0 })],
        );
      return {
        workspaceId,
        documentRevision: canvas?.revision ?? 0,
        panelIds: [...panels].sort(),
        layout,
        unplaced: panels.filter((p) => !crdt[p]).sort(),
        dropped: dropped.sort(),
        rule: "canvas existence (event log) is authoritative; a concurrent layout move never resurrects a deleted panel",
      };
    });
  }

  private tenant(s: Session) {
    return { orgId: s.principal.orgId, userId: s.userId };
  }

  private async access(tx: Tx, workspaceId: string): Promise<{ orgId: string }> {
    const w = (
      await tx.query("SELECT org_id FROM workspaces WHERE id = $1 AND archived_at IS NULL", [workspaceId])
    ).rows[0];
    if (!w) throw noWorkspaceAccess();
    return { orgId: w.org_id };
  }

  private async load(tx: Tx, workspaceId: string, scope: CollabScope): Promise<Y.Doc> {
    const doc = new Y.Doc();
    const rows = await tx.query<{ update: Buffer }>(
      "SELECT update FROM collab_updates WHERE workspace_id = $1 AND scope = $2 ORDER BY id",
      [workspaceId, scope],
    );
    for (const r of rows.rows) Y.applyUpdate(doc, new Uint8Array(r.update));
    return doc;
  }

  private validate(doc: Y.Doc, scope: CollabScope): void {
    for (const key of doc.share.keys())
      if (key !== ROOT[scope])
        throw bad("COLLAB_FOREIGN_ROOT", `Update touches "${key}" which is outside the ${scope} scope.`);
    if (scope === "layout") {
      const m = doc.getMap<unknown>("layout");
      if (m.size > MAX_LAYOUT_KEYS) throw bad("COLLAB_TOO_LARGE", "Too many layout entries.");
      for (const [k, v] of m.entries()) {
        const p = v as { x?: unknown; y?: unknown } | null;
        if (
          !p ||
          typeof p !== "object" ||
          typeof p.x !== "number" ||
          typeof p.y !== "number" ||
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          Math.abs(p.x) > COORD ||
          Math.abs(p.y) > COORD ||
          k.length > 200
        )
          throw bad("COLLAB_INVALID_LAYOUT", "Layout entries must be {x, y} finite coordinates.");
      }
    } else {
      const m = doc.getMap<unknown>("notes");
      let chars = 0;
      for (const [, v] of m.entries()) {
        if (!(v instanceof Y.Text)) throw bad("COLLAB_INVALID_NOTES", "Notes must be text.");
        chars += v.length;
      }
      if (chars > MAX_NOTES_CHARS) throw bad("COLLAB_TOO_LARGE", "Notes too large.");
    }
  }

  /** Merged state as one base64 Yjs update plus a decoded JSON view for clients that do not run Yjs. */
  async state(session: Session, workspaceId: string, scope: CollabScope) {
    return this.db.tx(this.tenant(session), async (tx) => {
      await this.access(tx, workspaceId);
      const doc = await this.load(tx, workspaceId, scope);
      const decoded =
        scope === "layout"
          ? Object.fromEntries(doc.getMap<unknown>("layout").entries())
          : Object.fromEntries([...doc.getMap<Y.Text>("notes").entries()].map(([k, t]) => [k, t.toString()]));
      const upd = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
      const seq = (
        await tx.query<{ n: string }>(
          "SELECT coalesce(max(id),0) AS n FROM collab_updates WHERE workspace_id = $1 AND scope = $2",
          [workspaceId, scope],
        )
      ).rows[0]!.n;
      return { workspaceId, scope, update: upd, cursor: Number(seq), decoded };
    });
  }

  /** Persist a client's update after validating the merged result. Returns the new cursor. */
  async applyUpdate(session: Session, workspaceId: string, scope: CollabScope, b64: string) {
    return this.db.tx(this.tenant(session), async (tx) => {
      const ws = await this.access(tx, workspaceId);
      if (!canWrite(session.role))
        throw new KernelError(
          "FORBIDDEN",
          "INSUFFICIENT_ROLE",
          "Role not permitted to edit collaboratively.",
        );
      const raw = Buffer.from(b64, "base64");
      if (raw.length === 0 || raw.length > MAX_UPDATE_BYTES)
        throw bad("COLLAB_BAD_UPDATE", "Update size out of range.");
      // Serialize writers per room so validation sees the same state that gets persisted.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `collab:${workspaceId}:${scope}`,
      ]);
      const doc = await this.load(tx, workspaceId, scope);
      try {
        Y.applyUpdate(doc, new Uint8Array(raw));
      } catch {
        throw bad("COLLAB_BAD_UPDATE", "Update is not a valid Yjs update.");
      }
      this.validate(doc, scope);
      const r = await tx.query<{ id: string }>(
        "INSERT INTO collab_updates(org_id, workspace_id, scope, update, actor_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [ws.orgId, workspaceId, scope, raw, session.userId],
      );
      return { cursor: Number(r.rows[0]!.id) };
    });
  }

  /** Update presence; only authorised members of THIS workspace can set or read it. */
  async setPresence(
    session: Session,
    workspaceId: string,
    scope: CollabScope,
    clientId: string,
    state: Record<string, unknown>,
  ) {
    await this.db.tx(this.tenant(session), (tx) => this.access(tx, workspaceId));
    if (JSON.stringify(state).length > 2000) throw bad("PRESENCE_TOO_LARGE", "Presence state too large.");
    const key = `${workspaceId}:${scope}`;
    const room = this.presence.get(key) ?? new Map<string, PresenceEntry>();
    this.presence.set(key, room);
    room.set(`${session.userId}:${clientId.slice(0, 64)}`, { userId: session.userId, state, at: Date.now() });
    return this.listPresence(session, workspaceId, scope);
  }

  async listPresence(session: Session, workspaceId: string, scope: CollabScope) {
    await this.db.tx(this.tenant(session), (tx) => this.access(tx, workspaceId));
    const room = this.presence.get(`${workspaceId}:${scope}`);
    const now = Date.now();
    const out: Array<{ userId: string; state: Record<string, unknown>; ageMs: number }> = [];
    if (room)
      for (const [k, e] of room) {
        if (now - e.at > PRESENCE_TTL_MS) room.delete(k);
        else out.push({ userId: e.userId, state: e.state, ageMs: now - e.at });
      }
    return { workspaceId, scope, peers: out };
  }
}

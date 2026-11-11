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

/** Y root name per scope. A scope's room may contain only its own root; anything else is rejected. */
const ROOT: Record<CollabScope, string> = { layout: "layout", notes: "notes" };

interface PresenceEntry {
  userId: string;
  state: Record<string, unknown>;
  at: number;
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

  constructor(private readonly db: Db) {}

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

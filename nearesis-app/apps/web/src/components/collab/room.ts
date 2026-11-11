/**
 * Scoped collaboration client (W15/W16) over the kernel's HTTP transport, through the same-origin BFF:
 *   GET  collab/:scope/state     merged Yjs state (base64) + cursor
 *   POST collab/:scope/updates   one base64 Yjs update; the server validates the merged result
 *   PUT  collab/:scope/presence  ephemeral presence for this workspace only
 *   GET  collab/layout/reconcile layout reconciled against the canvas event log
 * Only layout positions and notes text are collaborative. Evidence, panels and permissions change through commands.
 * Local edits are buffered while offline and sent as one merged update on reconnect; a refused update (e.g. a
 * viewer's edit) is discarded and the room is rebuilt from the server state, so nothing refused stays on screen.
 */
import * as Y from "yjs";

export type Scope = "layout" | "notes";
export type Point = { x: number; y: number };
const LOCAL = "local";
const REMOTE = "remote";

export function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export class CollabError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Network failure (offline, server down): edits stay buffered. A CollabError is a refusal: edits are dropped. */
class Offline extends Error {}

export class CollabRoom {
  doc = new Y.Doc();
  private pending: Uint8Array[] = [];
  /** Local edits made since the last acknowledged send. */
  buffered = 0;
  cursor = 0;
  private onUpdate = (u: Uint8Array, origin: unknown) => {
    if (origin === LOCAL) {
      this.pending.push(u);
      this.buffered++;
    }
  };

  constructor(
    readonly base: string,
    readonly scope: Scope,
  ) {
    this.doc.on("update", this.onUpdate);
  }

  private async req(path: string, init?: RequestInit): Promise<unknown> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/collab/${path}`, { cache: "no-store", ...init });
    } catch (e) {
      throw new Offline(String(e));
    }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status >= 500 || r.status === 0) throw new Offline(`HTTP ${r.status}`);
    if (!r.ok)
      throw new CollabError(
        r.status,
        String(body.reasonCode ?? body.errorCode ?? r.status),
        String(body.message ?? `HTTP ${r.status}`),
      );
    return body;
  }

  /** Applies a local edit (buffered until `flush`). */
  edit(fn: (d: Y.Doc) => void): void {
    this.doc.transact(() => fn(this.doc), LOCAL);
  }

  setPosition(key: string, p: Point): void {
    this.edit((d) => d.getMap<Point>("layout").set(key, { x: Math.round(p.x), y: Math.round(p.y) }));
  }
  removePosition(key: string): void {
    this.edit((d) => d.getMap("layout").delete(key));
  }

  layout(): Record<string, Point> {
    return Object.fromEntries(this.doc.getMap<Point>("layout").entries());
  }
  notes(): Record<string, string> {
    return Object.fromEntries(
      [...this.doc.getMap<Y.Text>("notes").entries()].map(([k, t]) => [k, t.toString()]),
    );
  }

  /** Replaces a note's text with a minimal splice (common prefix and suffix kept) so concurrent edits merge. */
  setNote(key: string, next: string): void {
    this.edit((d) => {
      const m = d.getMap<Y.Text>("notes");
      let t = m.get(key);
      if (!t) {
        t = new Y.Text();
        m.set(key, t);
      }
      const cur = t.toString();
      let a = 0;
      while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
      let b = 0;
      while (
        b < cur.length - a &&
        b < next.length - a &&
        cur[cur.length - 1 - b] === next[next.length - 1 - b]
      )
        b++;
      if (cur.length - a - b > 0) t.delete(a, cur.length - a - b);
      if (next.length - a - b > 0) t.insert(a, next.slice(a, next.length - b));
    });
  }

  /**
   * Sends buffered edits as one merged update. Returns "offline" when the network failed (edits kept), the refusal
   * when the server refused them (edits dropped, room rebuilt from the server), or null when sent or nothing to send.
   */
  async flush(): Promise<CollabError | "offline" | null> {
    if (!this.pending.length) return null;
    const merged = Y.mergeUpdates(this.pending);
    const n = this.pending.length;
    try {
      const r = (await this.req(`${this.scope}/updates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ update: toB64(merged) }),
      })) as { cursor: number };
      this.pending.splice(0, n);
      this.buffered = this.pending.length;
      this.cursor = Math.max(this.cursor, r.cursor);
      return null;
    } catch (e) {
      if (e instanceof Offline) return "offline";
      const refusal = e as CollabError;
      await this.rebuild().catch(() => undefined);
      return refusal;
    }
  }

  /** Pulls the merged server state into the local document (CRDT merge; local buffered edits are preserved). */
  async pull(): Promise<"offline" | null> {
    try {
      const s = (await this.req(`${this.scope}/state`)) as { update: string; cursor: number };
      Y.applyUpdate(this.doc, fromB64(s.update), REMOTE);
      this.cursor = s.cursor;
      return null;
    } catch (e) {
      if (e instanceof Offline) return "offline";
      throw e;
    }
  }

  /** Discards local state and reloads from the server (after a refusal). */
  private async rebuild(): Promise<void> {
    this.doc.off("update", this.onUpdate);
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.doc.on("update", this.onUpdate);
    this.pending = [];
    this.buffered = 0;
    await this.pull();
  }

  async setPresence(clientId: string, state: Record<string, unknown>): Promise<Peer[] | "offline"> {
    try {
      const r = (await this.req(`${this.scope}/presence?clientId=${encodeURIComponent(clientId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      })) as { peers: Peer[] };
      return r.peers;
    } catch (e) {
      if (e instanceof Offline) return "offline";
      throw e;
    }
  }

  async reconcile(): Promise<Reconciliation> {
    return (await this.req("layout/reconcile")) as Reconciliation;
  }

  destroy(): void {
    this.doc.destroy();
  }
}

export interface Peer {
  userId: string;
  state: Record<string, unknown>;
  ageMs: number;
}
export interface Reconciliation {
  workspaceId: string;
  documentRevision: number;
  panelIds: string[];
  layout: Record<string, Point>;
  unplaced: string[];
  dropped: string[];
  rule: string;
}

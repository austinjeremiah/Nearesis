import * as Y from "yjs";
import type { CollabConnection } from "../../src/history/collab.ts";

/** A collaborator: a local Yjs document wired to a server connection (updates out, frames in). */
export class CollabClient {
  readonly doc = new Y.Doc();
  sent = 0;
  constructor(
    readonly conn: CollabConnection,
    readonly scope: "layout" | "notes",
  ) {}

  /** Apply a local edit and push the resulting Yjs update to the server. */
  async edit(fn: (doc: Y.Doc) => void): Promise<{ cursor: number }> {
    let captured: Uint8Array | null = null;
    const h = (u: Uint8Array) => (captured = u);
    this.doc.on("update", h);
    this.doc.transact(() => fn(this.doc));
    this.doc.off("update", h);
    const r = await this.conn.send(Buffer.from(captured!).toString("base64"));
    this.sent++;
    return r;
  }

  /** Apply every frame received so far. */
  drain(): number {
    let n = 0;
    for (const f of this.conn.frames.splice(0)) {
      if (f.type === "update" && f.update) {
        Y.applyUpdate(this.doc, new Uint8Array(Buffer.from(f.update, "base64")));
        n++;
      }
    }
    return n;
  }

  layout(): Record<string, unknown> {
    return Object.fromEntries(this.doc.getMap<unknown>("layout").entries());
  }
  notes(): Record<string, string> {
    return Object.fromEntries(
      [...this.doc.getMap<Y.Text>("notes").entries()].map(([k, t]) => [k, t.toString()]),
    );
  }
}

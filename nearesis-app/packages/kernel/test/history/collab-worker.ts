import { parentPort, workerData } from "node:worker_threads";
import * as Y from "yjs";
import { Db } from "../../src/db/pool.ts";
import { CollabService } from "../../src/history/collab.ts";
import type { Session } from "../../src/auth.ts";

/**
 * One collaborator in its own worker thread: its own Y.Doc, its own database pool and CollabService. Several of these
 * run truly in parallel, so the server sees genuinely interleaved writers (advisory-lock contention included).
 */
interface Init {
  appUrl: string;
  session: Session;
  workspaceId: string;
}
type Op = { op: "set"; key: string; value: unknown } | { op: "delete"; key: string };
const init = workerData as Init;
const db = Db.connect(init.appUrl, 4);
const svc = new CollabService(db);
const doc = new Y.Doc();

async function pull(): Promise<void> {
  const st = await svc.state(init.session, init.workspaceId, "layout");
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(st.update, "base64")));
}
const push = (u: Uint8Array) =>
  svc.applyUpdate(init.session, init.workspaceId, "layout", Buffer.from(u).toString("base64"));
const layout = () => Object.fromEntries(doc.getMap<unknown>("layout").entries());

parentPort!.on("message", async (m: { cmd: string; ops?: Op[]; offline?: [number, number]; id: number }) => {
  try {
    if (m.cmd === "run") {
      await pull();
      const ops = m.ops!;
      let buffered = 0;
      for (let i = 0; i < ops.length; i++) {
        const offline = m.offline && i >= m.offline[0] && i < m.offline[1];
        let captured: Uint8Array | null = null;
        const h = (u: Uint8Array) => (captured = u);
        doc.on("update", h);
        doc.transact(() => {
          const o = ops[i]!;
          if (o.op === "set") doc.getMap("layout").set(o.key, o.value);
          else doc.getMap("layout").delete(o.key);
        });
        doc.off("update", h);
        if (offline) buffered++;
        else {
          await push(captured!);
          if (i % 2 === 0) await pull();
        }
      }
      parentPort!.postMessage({ id: m.id, ok: true, buffered });
    } else if (m.cmd === "local") {
      // Offline: apply operations to the local document only; nothing is sent to the server.
      for (const o of m.ops!)
        doc.transact(() => {
          if (o.op === "set") doc.getMap("layout").set(o.key, o.value);
          else doc.getMap("layout").delete(o.key);
        });
      parentPort!.postMessage({ id: m.id, ok: true, buffered: m.ops!.length });
    } else if (m.cmd === "reconnect") {
      // Reconnect: send everything done while offline in one update, then catch up.
      await push(Y.encodeStateAsUpdate(doc));
      await pull();
      parentPort!.postMessage({ id: m.id, ok: true });
    } else if (m.cmd === "sync") {
      await pull();
      parentPort!.postMessage({ id: m.id, ok: true, layout: layout() });
    } else if (m.cmd === "close") {
      await db.close();
      parentPort!.postMessage({ id: m.id, ok: true });
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String((e as Error).message) });
  }
});

import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { CollabScope } from "@nearesis/contracts";
import { KernelError } from "@nearesis/kernel";
import type { CollabConnection, CollabFrame, CollabService, Kernel, Session } from "@nearesis/kernel";

/**
 * Yjs collaboration over WebSocket (ch.03 "permission-checked WebSocket server", ch.11 "WebSocket only for Yjs").
 *
 * The socket is only a transport for the kernel's CollabService: the upgrade is refused (identical 404 for foreign and
 * unknown workspaces, 401 without a valid session) before any frame is exchanged; every update is validated and
 * persisted by the same code the HTTP routes use, so a socket cannot write anything the REST path cannot; and a revoked
 * member's socket is closed by the kernel's periodic revalidation (close code 4403).
 *
 * Wire protocol (JSON text frames):
 *   server -> client  {type:"sync", update, cursor, readOnly}    on open and on {type:"sync"}
 *                     {type:"update", scope, cursor, update}      another member's persisted update
 *                     {type:"presence", scope, peers}             ephemeral
 *                     {type:"ack", cursor} | {type:"error", code, reasonCode}
 *   client -> server  {type:"update", update:<base64 Yjs update>} | {type:"presence", state:{}} | {type:"sync"}
 * Browsers cannot set headers on a WebSocket: the bearer token may be sent as the subprotocol `nearesis.bearer.<token>`.
 */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 3_000_000;
const PING_MS = 15_000;
const PATH = /^\/v1\/workspaces\/([0-9a-f-]{36})\/collab\/([a-z]+)\/ws$/;
export const WS_CLOSE_REVOKED = 4403;
export const WS_CLOSE_BAD_FRAME = 4400;

function refuse(sock: Duplex, status: number, text: string) {
  sock.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Minimal RFC 6455 server-side framing: masked client frames in, unmasked frames out. */
class Peer {
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];
  private fragBytes = 0;
  private fragOp = 0;
  closed = false;
  alive = true;
  constructor(
    readonly sock: Duplex,
    private readonly onMessage: (text: string) => void,
    private readonly onEnd: () => void,
  ) {
    sock.on("data", (d: Buffer) => this.feed(d));
    sock.on("close", () => this.finish());
    sock.on("error", () => this.finish());
  }
  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onEnd();
  }
  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) return this.fail(1002);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE_BYTES || this.fragBytes + len > MAX_MESSAGE_BYTES) return this.fail(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      this.buf = this.buf.subarray(off + 4 + len);
      if (op >= 8) {
        if (!fin || len > 125) return this.fail(1002);
        if (op === 8) return this.close(1000, "");
        if (op === 9) this.write(0xa, payload);
        else if (op === 10) this.alive = true;
        continue;
      }
      if (op === 1 || op === 2) {
        if (this.frag.length) return this.fail(1002);
        this.fragOp = op;
      } else if (op !== 0 || !this.frag.length) return this.fail(1002);
      this.frag.push(payload);
      this.fragBytes += payload.length;
      if (fin) {
        const all = Buffer.concat(this.frag);
        const text = this.fragOp === 1 ? all.toString("utf8") : null;
        this.frag = [];
        this.fragBytes = 0;
        if (text === null) return this.fail(1003); // binary frames are not part of the protocol
        this.onMessage(text);
      }
    }
  }
  private fail(code: number) {
    this.close(code, "protocol error");
  }
  write(op: number, payload: Buffer) {
    if (this.closed || this.sock.destroyed) return;
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | op, n])
        : n < 65536
          ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | op;
              h[1] = 127;
              h.writeBigUInt64BE(BigInt(n), 2);
              return h;
            })();
    this.sock.write(Buffer.concat([head, payload]));
  }
  send(obj: unknown) {
    this.write(1, Buffer.from(JSON.stringify(obj), "utf8"));
  }
  close(code: number, reason: string) {
    if (!this.closed && !this.sock.destroyed) {
      const r = Buffer.from(reason, "utf8").subarray(0, 100);
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      this.write(8, p);
    }
    this.sock.end();
    this.finish();
  }
}

export interface CollabWsHandle {
  /** Close every open socket (used on app shutdown). */
  closeAll(): void;
  count(): number;
}

export function attachCollabWebSocket(server: Server, kernel: Kernel, collab: CollabService): CollabWsHandle {
  const peers = new Set<Peer>();
  const timer = setInterval(() => {
    for (const p of peers) {
      if (!p.alive) p.close(1001, "ping timeout");
      else {
        p.alive = false;
        p.write(0x9, Buffer.alloc(0));
      }
    }
  }, PING_MS);
  timer.unref();

  server.on("upgrade", (req: IncomingMessage, sock: Duplex) => {
    void handle(req, sock).catch(() => {
      if (!sock.destroyed) refuse(sock, 500, "Internal Server Error");
    });
  });

  async function handle(req: IncomingMessage, sock: Duplex) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = PATH.exec(url.pathname);
    if (!m) return refuse(sock, 404, "Not Found");
    const key = req.headers["sec-websocket-key"];
    if (
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      req.headers["sec-websocket-version"] !== "13" ||
      typeof key !== "string"
    )
      return refuse(sock, 400, "Bad Request");
    // token: Authorization header, or the subprotocol `nearesis.bearer.<token>` (browsers cannot set headers)
    const protos = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const viaProto = protos.find((x) => x.startsWith("nearesis.bearer."));
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ")
      ? h.slice(7).trim()
      : viaProto?.slice("nearesis.bearer.".length);
    let session: Session;
    try {
      session = await kernel.identity.resolveSession(token);
    } catch {
      return refuse(sock, 401, "Unauthorized");
    }
    const scope = CollabScope.safeParse(m[2]);
    if (!scope.success) return refuse(sock, 404, "Not Found");
    let conn: CollabConnection;
    try {
      conn = await collab.connect(session, m[1]!, scope.data);
    } catch {
      return refuse(sock, 404, "Not Found"); // foreign and unknown workspaces are indistinguishable
    }
    if (sock.destroyed) {
      conn.close("client");
      return;
    }
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    sock.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(viaProto ? [`Sec-WebSocket-Protocol: ${viaProto}`] : []),
        "",
        "",
      ].join("\r\n"),
    );
    // serialise a socket's messages: updates apply in the order the client sent them
    let chain: Promise<void> = Promise.resolve();
    const peer: Peer = new Peer(
      sock,
      (text) => {
        chain = chain.then(() => onMessage(text)).catch(() => undefined);
      },
      () => {
        peers.delete(peer);
        conn.close("client");
      },
    );
    peers.add(peer);
    conn.onFrame = (f: CollabFrame) => peer.send(f);
    conn.onClosed = (reason) => {
      if (reason === "revoked") peer.close(WS_CLOSE_REVOKED, "membership revoked");
      else peer.close(1000, reason);
    };
    const sync = async () => {
      const st = await collab.state(session, conn.workspaceId, conn.scope);
      peer.send({ type: "sync", scope: conn.scope, update: st.update, cursor: st.cursor, readOnly: false });
    };
    const onMessage = async (text: string) => {
      let msg: { type?: string; update?: unknown; state?: unknown };
      try {
        msg = JSON.parse(text) as typeof msg;
      } catch {
        return peer.close(WS_CLOSE_BAD_FRAME, "invalid JSON");
      }
      try {
        if (msg.type === "update" && typeof msg.update === "string") {
          const r = await conn.send(msg.update);
          peer.send({ type: "ack", cursor: r.cursor });
        } else if (msg.type === "presence" && msg.state && typeof msg.state === "object") {
          await conn.setPresence(msg.state as Record<string, unknown>);
          peer.send({ type: "ack", cursor: null });
        } else if (msg.type === "sync") await sync();
        else peer.send({ type: "error", code: "VALIDATION_FAILED", reasonCode: "UNKNOWN_FRAME" });
      } catch (e) {
        if (e instanceof KernelError)
          peer.send({ type: "error", code: e.code, reasonCode: e.reasonCode ?? e.code });
        else peer.send({ type: "error", code: "INTERNAL", reasonCode: "INTERNAL" });
      }
    };
    await sync().catch(() => peer.close(1011, "sync failed"));
  }

  return {
    closeAll() {
      clearInterval(timer);
      for (const p of [...peers]) p.close(1001, "server shutdown");
    },
    count: () => peers.size,
  };
}

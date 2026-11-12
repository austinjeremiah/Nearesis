import * as Y from 'yjs';

/**
 * Yjs provider for the Nearesis collaboration socket (apps/api collab-ws.ts). This is NOT y-websocket: the wire is
 * JSON text frames carrying base64 Yjs updates.
 *
 *   server -> client  {type:"sync", update, cursor, readOnly} | {type:"update", update, cursor} | {type:"presence", peers}
 *                     {type:"ack", cursor} | {type:"error", code, reasonCode}
 *   client -> server  {type:"update", update} | {type:"presence", state} | {type:"sync"}
 *
 * The socket authenticates with a single-use ticket from the BFF (`POST /api/collab/:wid`); the bearer never reaches
 * script. Every update is re-validated and persisted by the server (it rejects roots outside the scope, bad shapes,
 * oversize), so a peer cannot write anything the server would refuse. State that belongs to the event log (the canvas,
 * markers, evidence) is not stored here: it changes only through commands.
 *
 * Close code 4403 means the member's access was revoked: the provider stops and does not reconnect.
 */
export type CollabStatus = 'connecting' | 'open' | 'closed' | 'revoked' | 'denied';
export type CollabScope = 'layout' | 'notes';
export type CollabPeer = { userId: string; state: Record<string, unknown> };

const REMOTE = Symbol('remote');
const b64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class CollabProvider {
  readonly doc = new Y.Doc();
  status: CollabStatus = 'connecting';
  peers: CollabPeer[] = [];
  /** Last server error frame, e.g. {code:'FORBIDDEN', reasonCode:'INSUFFICIENT_ROLE'}. */
  lastError: { code: string; reasonCode: string } | null = null;
  synced = false;
  private sock: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = false;
  private dirty = false;
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(
    readonly wid: string,
    readonly scope: CollabScope,
    private presence: Record<string, unknown> = {},
  ) {
    this.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.dirty = true;
      this.send({ type: 'update', update: b64(u) });
    });
    void this.open();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  /** Snapshot token for useSyncExternalStore. */
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
  private setStatus(s: CollabStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit();
  }

  setPresence(state: Record<string, unknown>) {
    this.presence = state;
    this.send({ type: 'presence', state });
  }

  private send(frame: unknown) {
    if (this.sock && this.sock.readyState === WebSocket.OPEN) this.sock.send(JSON.stringify(frame));
  }

  private async open() {
    if (this.stopped) return;
    this.setStatus('connecting');
    try {
      const r = await fetch(`/api/collab/${encodeURIComponent(this.wid)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ scope: this.scope }),
      });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403 || r.status === 404) return this.setStatus('denied');
        return this.retry();
      }
      const t = (await r.json()) as { wsUrl: string; subprotocol: string };
      if (this.stopped) return;
      const sock = new WebSocket(t.wsUrl, [t.subprotocol]);
      this.sock = sock;
      sock.onopen = () => {
        this.attempt = 0;
        this.setStatus('open');
        this.send({ type: 'presence', state: this.presence });
      };
      sock.onmessage = (ev) => this.onFrame(String(ev.data));
      sock.onclose = (ev) => {
        this.sock = null;
        this.synced = false;
        this.peers = [];
        if (this.stopped) return;
        if (ev.code === 4403) return this.setStatus('revoked');
        this.setStatus('closed');
        this.retry();
      };
      sock.onerror = () => sock.close();
    } catch {
      this.setStatus('closed');
      this.retry();
    }
  }

  private retry() {
    if (this.stopped) return;
    this.attempt += 1;
    this.timer = setTimeout(() => void this.open(), Math.min(15_000, 500 * 2 ** this.attempt));
  }

  private onFrame(text: string) {
    let f: { type?: string; update?: string; peers?: CollabPeer[]; code?: string; reasonCode?: string };
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if ((f.type === 'sync' || f.type === 'update') && typeof f.update === 'string') {
      Y.applyUpdate(this.doc, unb64(f.update), REMOTE);
      if (f.type === 'sync') {
        this.synced = true;
        // edits made while offline are merged in (idempotent for the server's copy)
        if (this.dirty) this.send({ type: 'update', update: b64(Y.encodeStateAsUpdate(this.doc)) });
      }
      this.emit();
    } else if (f.type === 'presence' && f.peers) {
      this.peers = f.peers;
      this.emit();
    } else if (f.type === 'ack') {
      this.lastError = null;
    } else if (f.type === 'error') {
      this.lastError = { code: f.code ?? 'ERROR', reasonCode: f.reasonCode ?? '' };
      this.emit();
    }
  }

  destroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.sock?.close();
    this.doc.destroy();
  }
}

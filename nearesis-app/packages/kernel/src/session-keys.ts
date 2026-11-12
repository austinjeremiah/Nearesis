import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One HS256 signing key. `retiredAtMs` is set when a newer key replaced it; it still verifies until its window closes. */
export interface SessionKey {
  kid: string;
  /** hex, 32 random bytes (or an operator-supplied secret); never logged */
  secret: string;
  createdAtMs: number;
  retiredAtMs: number | null;
}

interface KeyringFile {
  version: 1;
  keys: SessionKey[];
}

/**
 * Session signing key ring. The newest non-retired key signs; any key still inside its window verifies, so tokens
 * survive both API restarts (file-backed) and key rotation (retired keys verify for `windowMs` after retirement,
 * which must be at least the token lifetime). The file is created 0600 and never logged.
 */
export class SessionKeyRing {
  private keys: SessionKey[] = [];
  constructor(
    private readonly opts: {
      /** Persist here (0600, atomic rename). Absent: in-memory only (tests, production OIDC deployments). */
      path?: string;
      /** How long a retired key keeps verifying (ms). Default 24 h. */
      windowMs?: number;
      /** Operator-supplied secret (NEARESIS_SESSION_SECRET): used as the sole key, stable across restarts. */
      fixedSecret?: string;
      now?: () => number;
    } = {},
  ) {
    const now = this.now();
    if (opts.fixedSecret) {
      this.keys = [{ kid: "env", secret: toHex(opts.fixedSecret), createdAtMs: now, retiredAtMs: null }];
      return;
    }
    if (opts.path && existsSync(opts.path)) this.keys = this.read(opts.path);
    if (!this.keys.some((k) => k.retiredAtMs === null)) this.rotate();
    else this.prune();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
  private get windowMs(): number {
    return this.opts.windowMs ?? 24 * 3600_000;
  }

  private read(path: string): SessionKey[] {
    try {
      const f = JSON.parse(readFileSync(path, "utf8")) as KeyringFile;
      if (f.version !== 1 || !Array.isArray(f.keys)) throw new Error("shape");
      return f.keys.filter(
        (k) =>
          typeof k.kid === "string" && /^[0-9a-f]{32,}$/.test(k.secret) && typeof k.createdAtMs === "number",
      );
    } catch {
      // A corrupt ring is replaced (existing sessions are invalidated) rather than blocking boot.
      return [];
    }
  }

  private persist(): void {
    const path = this.opts.path;
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, keys: this.keys } satisfies KeyringFile), {
      mode: 0o600,
    });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private prune(): void {
    const now = this.now();
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.retiredAtMs === null || now - k.retiredAtMs <= this.windowMs);
    if (this.keys.length !== before) this.persist();
  }

  /** Retire the current signing key (it keeps verifying for the window) and start a new one. */
  rotate(): SessionKey {
    const now = this.now();
    for (const k of this.keys) if (k.retiredAtMs === null) k.retiredAtMs = now;
    const key: SessionKey = {
      kid: randomBytes(8).toString("hex"),
      secret: randomBytes(32).toString("hex"),
      createdAtMs: now,
      retiredAtMs: null,
    };
    this.keys.push(key);
    this.keys = this.keys.filter((k) => k.retiredAtMs === null || now - k.retiredAtMs <= this.windowMs);
    this.persist();
    return key;
  }

  signing(): { kid: string; secret: Uint8Array } {
    const k = this.keys.find((x) => x.retiredAtMs === null)!;
    return { kid: k.kid, secret: Buffer.from(k.secret, "hex") };
  }

  /** The verification key for `kid`, or null when unknown or past its window. A missing kid tries only the signing key. */
  verifying(kid: string | undefined): Uint8Array | null {
    const k =
      kid === undefined
        ? this.keys.find((x) => x.retiredAtMs === null)
        : this.keys.find((x) => x.kid === kid);
    if (!k) return null;
    if (k.retiredAtMs !== null && this.now() - k.retiredAtMs > this.windowMs) return null;
    return Buffer.from(k.secret, "hex");
  }
}

function toHex(s: string): string {
  const h = Buffer.from(s, "utf8").toString("hex");
  return h.length >= 32 ? h : randomBytes(32).toString("hex");
}

import { createHash, randomBytes } from "node:crypto";
import type { Session } from "@nearesis/kernel";

/**
 * Short-lived, single-use tickets for the collaboration WebSocket. A browser cannot set an Authorization header on a
 * WebSocket and a cookie-authenticated frontend must not hand its HttpOnly token to script, so the frontend server asks the
 * API for a ticket (with the bearer token) and gives the browser only that. The ticket:
 *   - is bound to one workspace (and optionally one scope) and to the session that asked for it;
 *   - is valid for `ttlMs` (default 30 s) and is burned by the first redemption, successful or not;
 *   - is held in memory as a hash, so a process restart invalidates every ticket (they are 30 seconds long anyway).
 * Redemption yields the Session captured at issue time; the kernel's collab service still checks workspace access when the
 * socket connects and revalidates membership while it is open.
 */
interface Entry {
  session: Session;
  workspaceId: string;
  scope: string | null;
  expiresAt: number;
}

export class CollabTicketStore {
  private readonly entries = new Map<string, Entry>();
  constructor(
    readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
    private readonly max = 10_000,
  ) {}

  private static key(ticket: string): string {
    return createHash("sha256").update(ticket).digest("hex");
  }

  issue(session: Session, workspaceId: string, scope: string | null): { ticket: string; expiresAt: number } {
    const t = this.now();
    if (this.entries.size >= this.max / 2)
      for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value as string);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = t + this.ttlMs;
    this.entries.set(CollabTicketStore.key(ticket), { session, workspaceId, scope, expiresAt });
    return { ticket, expiresAt };
  }

  /** Burns the ticket; returns its session only when it is unexpired and matches the workspace and scope being opened. */
  redeem(ticket: string, workspaceId: string, scope: string): Session | null {
    const k = CollabTicketStore.key(ticket);
    const e = this.entries.get(k);
    this.entries.delete(k);
    if (!e || e.expiresAt <= this.now()) return null;
    if (e.workspaceId !== workspaceId || (e.scope !== null && e.scope !== scope)) return null;
    return e.session;
  }

  size(): number {
    return this.entries.size;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    collabTickets: CollabTicketStore;
  }
}

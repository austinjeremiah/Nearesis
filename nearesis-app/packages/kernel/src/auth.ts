import { randomUUID } from "node:crypto";
import { SignJWT, decodeProtectedHeader, jwtVerify } from "jose";
import type { Principal, Role } from "@nearesis/contracts";
import type { Db } from "./db/pool.ts";
import { KernelError } from "./errors.ts";
import { SessionKeyRing } from "./session-keys.ts";

export interface Session {
  principal: Principal;
  role: Role;
  userId: string;
}

/** Pluggable authentication. OIDC adapter is NOT yet implemented; DevAuthProvider is non-production only. */
export interface AuthProvider {
  authenticate(token: string): Promise<{ userId: string; orgId: string; jti?: string }>;
}

const ISSUER = "nearesis-kernel";
const AUDIENCE = "nearesis-api";

export class DevAuthProvider implements AuthProvider {
  private readonly keys: SessionKeyRing;
  /**
   * Key source, in order: an operator secret (NEARESIS_SESSION_SECRET, >= 16 chars); else a persisted key ring at
   * `keyringPath` so sessions survive API restarts; else an ephemeral in-memory key (tests).
   */
  constructor(
    private readonly db: Db,
    secret: string | undefined = process.env.NEARESIS_SESSION_SECRET,
    private readonly nodeEnv: string | undefined = process.env.NODE_ENV,
    private readonly ttlSeconds = 3600,
    keyringPath: string | undefined = process.env.NEARESIS_SESSION_KEYRING,
    keyring?: SessionKeyRing,
  ) {
    this.keys =
      keyring ??
      new SessionKeyRing({
        ...(secret && secret.length >= 16
          ? { fixedSecret: secret }
          : keyringPath
            ? { path: keyringPath }
            : {}),
        windowMs: Math.max(ttlSeconds * 1000 * 2, 3600_000),
      });
  }

  /** Rotate the signing key; tokens signed by the previous key stay valid for the retirement window. */
  rotateKey(): void {
    this.keys.rotate();
  }

  /** Dev login: only when NODE_ENV !== "production". Issues a session JWT for a seeded user. */
  async login(oidcSubject: string): Promise<string> {
    if (this.nodeEnv === "production") {
      throw new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
    }
    const r = await this.db.txGlobal((tx) =>
      tx.query<{ user_id: string; org_id: string }>("SELECT user_id, org_id FROM auth_resolve_subject($1)", [
        oidcSubject,
      ]),
    );
    const row = r.rows[0];
    if (!row) throw new KernelError("UNAUTHENTICATED", "UNKNOWN_SUBJECT", "Unknown subject.");
    const signing = this.keys.signing();
    return new SignJWT({ org: row.org_id })
      .setProtectedHeader({ alg: "HS256", kid: signing.kid })
      .setSubject(row.user_id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(signing.secret);
  }

  async authenticate(token: string): Promise<{ userId: string; orgId: string; jti?: string }> {
    try {
      const secret = this.keys.verifying(decodeProtectedHeader(token).kid);
      if (!secret) throw new Error("kid");
      const { payload } = await jwtVerify(token, secret, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || typeof payload.org !== "string") throw new Error("claims");
      return {
        userId: payload.sub,
        orgId: payload.org,
        ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
      };
    } catch {
      throw new KernelError("UNAUTHENTICATED", "INVALID_SESSION", "Invalid or expired session.");
    }
  }
}

/** Resolves the server-side Principal from a token + membership row. Never from request bodies. */
export class IdentityPolicy {
  constructor(
    private readonly db: Db,
    private readonly provider: AuthProvider,
  ) {}

  revoke(token: string, reason?: string): Promise<void> {
    return revokeSession(this.db, this.provider, token, reason);
  }

  async resolveSession(token: string | undefined): Promise<Session> {
    if (!token) throw new KernelError("UNAUTHENTICATED", "MISSING_SESSION", "Authentication required.");
    const { userId, orgId, jti } = await this.provider.authenticate(token);
    const role = await this.db.tx({ orgId, userId }, async (tx) => {
      if (jti) {
        const rv = await tx.query("SELECT 1 FROM revoked_sessions WHERE jti = $1", [jti]);
        if (rv.rowCount) return "revoked" as const;
      }
      const r = await tx.query<{ role: Role }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
        [orgId, userId],
      );
      return r.rows[0]?.role;
    });
    if (role === "revoked")
      throw new KernelError("UNAUTHENTICATED", "SESSION_REVOKED", "Invalid or expired session.");
    if (!role) throw new KernelError("UNAUTHENTICATED", "NO_MEMBERSHIP", "Invalid or expired session.");
    return { principal: { kind: "human", actorId: userId, orgId }, role, userId };
  }
}

/** Revokes the presented session token (logout, incident response); effective on the very next request. */
export async function revokeSession(
  db: Db,
  provider: AuthProvider,
  token: string,
  reason = "logout",
): Promise<void> {
  const { userId, orgId, jti } = await provider.authenticate(token);
  if (!jti) throw new KernelError("VALIDATION_FAILED", "NO_SESSION_ID", "Token has no session id.");
  await db.tx({ orgId, userId }, (tx) =>
    tx.query(
      "INSERT INTO revoked_sessions(jti, org_id, user_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [jti, orgId, userId, reason],
    ),
  );
}

/** Server-side session for background work done on a user's behalf (scheduler tasks). Null when they can no longer write. */
export async function sessionForUser(db: Db, orgId: string, userId: string): Promise<Session | null> {
  const role = await db.tx({ orgId, userId }, async (tx) => {
    const r = await tx.query<{ role: Role }>(
      "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
      [orgId, userId],
    );
    return r.rows[0]?.role;
  });
  if (!role || !canWrite(role)) return null;
  return { principal: { kind: "human", actorId: userId, orgId }, role, userId };
}

const WRITE_ROLES: readonly Role[] = ["owner", "admin", "analyst"];
const ADMIN_ROLES: readonly Role[] = ["owner", "admin"];
export const canWrite = (r: Role): boolean => WRITE_ROLES.includes(r);
export const canAdmin = (r: Role): boolean => ADMIN_ROLES.includes(r);

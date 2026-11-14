import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { KernelError } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";
import { RunsService } from "./runs.ts";

export interface GatewayCredentialConfig {
  /** Shared HS256 secret with the MCP gateway. Server-side only: never logged, never returned. */
  secret: string;
  /** The audience this API accepts (default `nearesis-api`). A credential minted for any other audience is refused. */
  audience: string;
}

const Uuid = z.uuid();
const Claims = z.object({
  iss: z.literal("nearesis-mcp-gateway"),
  sub: z.literal("mcp-gateway"),
  aud: z.string(),
  scope: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  org: Uuid,
  usr: Uuid,
  ws: Uuid,
});
export type GatewayClaims = z.infer<typeof Claims>;

const unauthenticated = () =>
  new KernelError("UNAUTHENTICATED", "INVALID_GATEWAY_CREDENTIAL", "Invalid or expired credential.");

/**
 * Verifies the MCP gateway's credential: HS256 (constant-time signature check), issuer, audience, expiry (short-lived:
 * at most 5 minutes), scope, and the principal it acts for (org, user, workspace). Every failure is the same error.
 */
export function verifyGatewayCredential(
  token: string | undefined,
  cfg: GatewayCredentialConfig,
  requiredScope: string,
  now = new Date(),
): GatewayClaims {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3) throw unauthenticated();
  const [h, b, s] = parts as [string, string, string];
  try {
    const head = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown };
    if (head.alg !== "HS256") throw unauthenticated();
    const want = createHmac("sha256", cfg.secret).update(`${h}.${b}`).digest();
    const got = Buffer.from(s, "base64url");
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw unauthenticated();
    const c = Claims.parse(JSON.parse(Buffer.from(b, "base64url").toString("utf8")));
    const nowS = Math.floor(now.getTime() / 1000);
    if (c.aud !== cfg.audience || c.exp <= nowS || c.exp - c.iat > 300 || c.iat > nowS + 30)
      throw unauthenticated();
    if (!c.scope.split(" ").includes(requiredScope)) throw unauthenticated();
    return c;
  } catch (e) {
    throw e instanceof KernelError ? e : unauthenticated();
  }
}

/**
 * Routes that exist only for the MCP gateway's own credential (never a user session, which this surface refuses).
 * `GET /v1/gateway/runs/:id` answers `task_status`: the credential names the org, user and workspace the gateway
 * authenticated; the run is read under that member's RLS and must belong to that workspace, otherwise the answer is the
 * same 404 as a nonexistent run.
 */
export const gatewayRoutes: FastifyPluginAsync<{
  kernel: Kernel;
  credential: GatewayCredentialConfig;
}> = async (app, { kernel, credential }) => {
  const runs = new RunsService(kernel, {
    start: () => Promise.reject(new Error("read-only")),
    signal: () => Promise.reject(new Error("read-only")),
  });
  app.get<{ Params: { id: string } }>("/v1/gateway/runs/:id", async (req) => {
    const h = req.headers.authorization;
    const token = h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
    const claims = verifyGatewayCredential(token, credential, "runs:read");
    const notFound = () => new KernelError("NOT_FOUND", "NOT_FOUND", "Not found.");
    if (req.headers["x-workspace-id"] !== claims.ws) throw notFound();
    if (!Uuid.safeParse(req.params.id).success) throw notFound();
    const role = await kernel.db.tx({ orgId: claims.org, userId: claims.usr }, async (tx) => {
      const r = await tx.query<{ role: Session["role"] }>(
        "SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2",
        [claims.org, claims.usr],
      );
      return r.rows[0]?.role;
    });
    if (!role) throw unauthenticated();
    const session: Session = {
      principal: { kind: "service", actorId: claims.usr, orgId: claims.org },
      role,
      userId: claims.usr,
    };
    const run = await runs.getRun(session, req.params.id);
    if (run.workspaceId !== claims.ws) throw notFound();
    return { id: run.runId, status: run.state, updatedAt: run.updatedAt };
  });
};

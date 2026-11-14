import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { KernelError, OidcClient, oidcConfigFromEnv } from "@nearesis/kernel";
import type { Kernel } from "@nearesis/kernel";

export interface OidcRoutesOptions {
  kernel: Kernel;
  /** Test seam. Default: configured from NEARESIS_OIDC_* (see packages/kernel/src/oidc.ts); absent env = feature off. */
  client?: OidcClient | null;
  /** Per-IP attempts per minute across both routes. Default 30. */
  perMinute?: number;
  now?: () => number;
}

/** `exp` (ms) of a session JWT, for the response only; the signature was just produced by this process. */
function expiryOf(token: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof p.exp === "number" ? new Date(p.exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

const LoginQ = z.object({
  returnTo: z.string().max(500).optional(),
  mode: z.enum(["redirect", "json"]).optional(),
});
const CallbackQ = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Generic OIDC sign-in (authorization code + PKCE). Both routes are unauthenticated by nature and exist only when an
 * issuer is configured: with none they answer 404 `OIDC_NOT_CONFIGURED`.
 *
 *   GET /v1/auth/oidc/login?returnTo=/path[&mode=json]   -> 302 to the provider (or `{authorizationUrl,state,expiresInSeconds}`
 *        with `mode=json` or `Accept: application/json`, for a frontend server that sets its own state cookie)
 *   GET /v1/auth/oidc/callback?code=&state=               -> `{token, expiresAt, returnTo}`: the same session JWT as dev login
 *
 * The registered redirect URI is the frontend's callback page, which forwards `code` and `state` here server-to-server. The
 * frontend must bind `state` to the browser that started the login (its own HttpOnly cookie) before forwarding it: the API
 * keeps the PKCE verifier and nonce per state, single use, 10 minutes. An unknown subject is refused, never provisioned.
 */
export const oidcRoutes: FastifyPluginAsync<OidcRoutesOptions> = async (app, opts) => {
  const client = opts.client === undefined ? makeFromEnv() : opts.client;
  const now = opts.now ?? Date.now;
  const limit = opts.perMinute ?? 30;
  const hits = new Map<string, { start: number; n: number }>();
  const throttle = (ip: string, reply: FastifyReply) => {
    const t = now();
    if (hits.size > 5000) for (const [k, b] of hits) if (t - b.start >= 60_000) hits.delete(k);
    let b = hits.get(ip);
    if (!b || t - b.start >= 60_000) hits.set(ip, (b = { start: t, n: 0 }));
    if (++b.n > limit) {
      const s = Math.max(1, Math.ceil((b.start + 60_000 - t) / 1000));
      void reply.header("retry-after", String(s));
      throw new KernelError("RATE_LIMITED", "TOO_MANY_LOGINS", "Too many sign-in attempts.", {
        retryable: true,
        nextAction: `Retry after ${s} seconds.`,
      });
    }
  };
  const configured = (): OidcClient => {
    if (!client)
      throw new KernelError(
        "NOT_FOUND",
        "OIDC_NOT_CONFIGURED",
        "Sign-in with an identity provider is not configured.",
      );
    return client;
  };

  app.get("/v1/auth/oidc/login", async (req, reply) => {
    const c = configured();
    throttle(req.ip, reply);
    const q = LoginQ.safeParse(req.query);
    if (!q.success) throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query.");
    const r = await c.begin(q.data.returnTo);
    if (q.data.mode === "json" || String(req.headers.accept ?? "").includes("application/json")) return r;
    return reply.redirect(r.authorizationUrl, 302);
  });

  app.get("/v1/auth/oidc/callback", async (req, reply) => {
    const c = configured();
    throttle(req.ip, reply);
    const q = CallbackQ.safeParse(req.query);
    if (!q.success) throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "Invalid query.");
    if (q.data.error)
      throw new KernelError(
        "UNAUTHENTICATED",
        "OIDC_PROVIDER_REFUSED",
        "The identity provider refused the sign-in.",
      );
    if (!q.data.code || !q.data.state)
      throw new KernelError("VALIDATION_FAILED", "INVALID_QUERY", "code and state are required.");
    const { subject, returnTo } = await c.complete(q.data.code, q.data.state);
    const auth = opts.kernel.devAuth;
    if (!auth)
      throw new KernelError(
        "UPSTREAM_DEGRADED",
        "SESSION_ISSUER_UNAVAILABLE",
        "Sessions cannot be issued here.",
      );
    let token: string;
    try {
      token = await auth.issueSession(subject);
    } catch (e) {
      // The provider vouched for the identity but no user is provisioned for it: not a server fault.
      if (e instanceof KernelError && e.reasonCode === "UNKNOWN_SUBJECT")
        throw new KernelError(
          "FORBIDDEN",
          "OIDC_USER_NOT_PROVISIONED",
          "This identity has no account in Nearesis.",
          {
            nextAction: "Ask an organisation owner to add you.",
          },
        );
      throw e;
    }
    return { token, expiresAt: expiryOf(token), returnTo };
  });
};

function makeFromEnv(): OidcClient | null {
  const cfg = oidcConfigFromEnv();
  return cfg ? new OidcClient(cfg) : null;
}

(oidcRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;

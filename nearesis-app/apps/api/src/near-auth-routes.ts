import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KernelError, NearAuthService, isWellFormedNearAccountId } from "@nearesis/kernel";
import type { Kernel, Session } from "@nearesis/kernel";

export interface NearAuthRoutesOptions {
  kernel: Kernel;
  authenticate(req: FastifyRequest): Promise<Session>;
  /** Test seam (mock RPC). Default: testnet RPC from NEARESIS_NEAR_RPC. */
  service?: NearAuthService;
  /** Per-IP requests per minute across the three routes. Default 30. */
  perMinute?: number;
  now?: () => number;
}

const VerifyBody = z.strictObject({
  challengeId: z.uuid(),
  accountId: z.string().min(2).max(64),
  publicKey: z.string().min(9).max(100),
  signature: z.string().min(1).max(200),
});

/**
 * NEAR wallet sign-in (NEP-413, testnet).
 *   POST /v1/auth/near/challenge  {}                                          -> challenge
 *   POST /v1/auth/near/verify     {challengeId, accountId, publicKey, signature} -> {token, userId, accountId, created}
 *   POST /v1/auth/near/link       same body, session required                -> {accountId, userId}
 */
export const nearAuthRoutes: FastifyPluginAsync<NearAuthRoutesOptions> = async (app, opts) => {
  const { kernel } = opts;
  const service = opts.service ?? new NearAuthService(kernel.db);
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
  const parse = (body: unknown) => {
    const b = VerifyBody.safeParse(body);
    if (!b.success || !isWellFormedNearAccountId(b.data.accountId))
      throw new KernelError("VALIDATION_FAILED", "INVALID_BODY", "Invalid request body.");
    return b.data;
  };

  app.post("/v1/auth/near/challenge", async (req, reply) => {
    throttle(req.ip, reply);
    return service.issueChallenge();
  });

  app.post("/v1/auth/near/verify", async (req, reply) => {
    throttle(req.ip, reply);
    const body = parse(req.body);
    const auth = kernel.devAuth;
    if (!auth)
      throw new KernelError("UPSTREAM_DEGRADED", "SESSION_ISSUER_UNAVAILABLE", "Sessions cannot be issued here.");
    const r = await service.signIn(body);
    const token = await auth.issueSessionFor(r.userId, r.orgId);
    return { token, userId: r.userId, accountId: r.accountId, created: r.created };
  });

  app.post("/v1/auth/near/link", async (req, reply) => {
    const s = await opts.authenticate(req);
    throttle(req.ip, reply);
    return service.link(s.userId, s.principal.orgId, parse(req.body));
  });
};

(nearAuthRoutes as unknown as Record<symbol, boolean>)[Symbol.for("skip-override")] = true;

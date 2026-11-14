import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { KernelError, toErrorResponse } from "@nearesis/kernel";
import { parseStrictJson } from "@nearesis/strict-json";

/**
 * Browser-to-API request guards (ch.12 trust matrix "Browser -> API", ch.11): cross-origin mutation refusal, JSON-only
 * mutation bodies, and a fixed-window rate limiter with `Retry-After`. The API authenticates with a bearer token in the
 * `Authorization` header and issues no cookies, so there is no ambient credential for a forged cross-site request to
 * ride on; the Origin check and the JSON-only rule are the remaining cross-site defences for a browser client that holds
 * the token. Refusals use the structured error body with `traceId`.
 */
export interface RequestGuardOptions {
  /** Origins allowed to make mutating browser requests. Same-origin (Origin equals the request Host) is always allowed. */
  allowedOrigins?: string[];
  /** Mutating requests per window per client (IP plus credential). Default 300. */
  mutationsPerWindow?: number;
  /** `POST /v1/dev/login` per window per IP. Default 20. */
  loginsPerWindow?: number;
  windowMs?: number;
  /** Maximum JSON body size in bytes. Default 1,000,000 (the Fastify bodyLimit in app.ts is the same value). */
  maxBodyBytes?: number;
  /** TEST CONTROL ONLY: use Fastify's lenient default JSON parser, to prove the abuse suite detects its absence. */
  lenientJsonParser?: boolean;
  /** TEST CONTROL ONLY: switch the cross-origin check off to prove the attack suite detects it. */
  disableOriginCheck?: boolean;
  now?: () => number;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function requestGuards(app: FastifyInstance, opts: RequestGuardOptions = {}): void {
  const windowMs = opts.windowMs ?? 60_000;
  const mutations = opts.mutationsPerWindow ?? 300;
  const logins = opts.loginsPerWindow ?? 20;
  const now = opts.now ?? Date.now;
  const maxBody = opts.maxBodyBytes ?? 1_000_000;
  if (!opts.lenientJsonParser) {
    // One bounded, strict parser for every JSON body: UTF-8 validated, depth and node bounded, duplicate keys and
    // prototype-pollution keys refused (packages/strict-json). Errors are structured 422s with a reason code.
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: maxBody },
      (_req, body, done) => {
        const r = parseStrictJson(body as Buffer, { maxBytes: maxBody });
        if (r.ok) return done(null, r.value);
        const reason =
          r.code === "TOO_LARGE" ? "PAYLOAD_TOO_LARGE" : r.code === "EMPTY" ? "EMPTY_BODY" : `BODY_${r.code}`;
        done(new KernelError("VALIDATION_FAILED", reason, `Request body rejected: ${r.detail}.`) as never);
      },
    );
  }
  const buckets = new Map<string, { start: number; n: number }>();

  const take = (key: string, limit: number): { ok: boolean; retryAfterS: number } => {
    const t = now();
    if (buckets.size > 10_000) for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
    let b = buckets.get(key);
    if (!b || t - b.start >= windowMs) {
      b = { start: t, n: 0 };
      buckets.set(key, b);
    }
    b.n++;
    return { ok: b.n <= limit, retryAfterS: Math.max(1, Math.ceil((b.start + windowMs - t) / 1000)) };
  };

  const refuse = (
    req: FastifyRequest,
    reply: {
      status: (n: number) => { send: (b: unknown) => unknown };
      header: (k: string, v: string) => unknown;
    },
    err: KernelError,
    retryAfterS?: number,
  ) => {
    const { status, body } = toErrorResponse(err, req.traceId);
    if (retryAfterS !== undefined) void reply.header("retry-after", String(retryAfterS));
    return reply.status(status).send(body);
  };

  app.addHook("onRequest", async (req, reply) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("cache-control", "no-store");
    // Bodies are never decompressed by this API, so a compressed body is refused instead of being expanded.
    const enc = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
    if (enc !== "identity" && enc !== "")
      return refuse(
        req,
        reply as never,
        new KernelError(
          "VALIDATION_FAILED",
          "UNSUPPORTED_CONTENT_ENCODING",
          "Compressed request bodies are not accepted.",
        ),
      );
    if (!MUTATING.has(req.method)) return;
    const origin = req.headers.origin;
    if (!opts.disableOriginCheck && typeof origin === "string") {
      const same = origin === `${req.protocol}://${req.headers.host ?? ""}`;
      if (!same && !(opts.allowedOrigins ?? []).includes(origin))
        return refuse(
          req,
          reply as never,
          new KernelError("FORBIDDEN", "ORIGIN_NOT_ALLOWED", "Cross-origin mutation refused."),
        );
    }
    // A body, when present, must be JSON: form and text types are the "simple request" types a cross-site page can send.
    const hasBody =
      Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
    if (hasBody && !/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] ?? "")))
      return refuse(
        req,
        reply as never,
        new KernelError(
          "VALIDATION_FAILED",
          "UNSUPPORTED_CONTENT_TYPE",
          "Request bodies must be application/json.",
        ),
      );
    const cred = createHash("sha256")
      .update(String(req.headers.authorization ?? ""))
      .digest("hex")
      .slice(0, 16);
    const ip = req.ip;
    if (req.url.split("?")[0] === "/v1/dev/login") {
      const r = take(`login:${ip}`, logins);
      if (!r.ok)
        return refuse(
          req,
          reply as never,
          new KernelError("RATE_LIMITED", "TOO_MANY_LOGINS", "Too many sign-in attempts.", {
            retryable: true,
            nextAction: `Retry after ${r.retryAfterS} seconds.`,
          }),
          r.retryAfterS,
        );
      return;
    }
    const r = take(`mut:${ip}:${cred}`, mutations);
    if (!r.ok)
      return refuse(
        req,
        reply as never,
        new KernelError("RATE_LIMITED", "TOO_MANY_REQUESTS", "Too many requests.", {
          retryable: true,
          nextAction: `Retry after ${r.retryAfterS} seconds.`,
        }),
        r.retryAfterS,
      );
  });
}

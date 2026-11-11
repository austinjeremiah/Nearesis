import { createHmac } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_ROOT, loadSnapshot, readManifest, verifyCapsule } from "@nearesis/capsule";

/**
 * MCP gateway (ch.11 "MCP gateway", V17): exactly six read-only operations with a schema, a description and a narrow scope
 * each. Requests are untrusted input.
 *
 *  - Arguments are validated against strict schemas BEFORE the MCP layer sees them (HTTP 422), and an argument that
 *    names a host, URL, endpoint, credential or header is refused outright (HTTP 403). A client can never choose where
 *    the gateway connects.
 *  - Downstream calls (`task_status`) go to ONE base URL fixed at construction, validated to be loopback or an explicit
 *    allowlist, with the gateway's own short-lived, audience-constrained credential. The caller's bearer token resolves
 *    the principal and is never forwarded.
 *  - The workspace comes from the authenticated principal, never from arguments.
 *  - Text in arguments is data: it is only ever matched against stored claims.
 */
export const GATEWAY_TOOLS = [
  "semantic_discover",
  "semantic_query",
  "evidence_search",
  "chart_preview",
  "task_status",
  "capsule_verify",
] as const;
export type GatewayTool = (typeof GATEWAY_TOOLS)[number];

export interface GatewayPrincipal {
  id: string;
  kind: "anonymous" | "member";
  /** Set by authentication only. Never taken from request arguments. */
  workspaceId: string | null;
}
export const PUBLIC_PRINCIPAL: GatewayPrincipal = { id: "anonymous", kind: "anonymous", workspaceId: null };

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
const RUN_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/);
const ARGS: Record<GatewayTool, z.ZodType> = {
  semantic_discover: z.strictObject({}),
  semantic_query: z.strictObject({ capsuleId: ID, metricId: ID }),
  evidence_search: z.strictObject({
    text: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  chart_preview: z.strictObject({ capsuleId: ID }),
  task_status: z.strictObject({ runId: RUN_ID }),
  capsule_verify: z.strictObject({ capsuleId: ID }),
};
const SCOPES: Record<GatewayTool, string[]> = {
  semantic_discover: ["capsule:read"],
  semantic_query: ["capsule:read"],
  evidence_search: ["capsule:read"],
  chart_preview: ["capsule:read"],
  task_status: ["runs:read"],
  capsule_verify: ["capsule:verify"],
};
const MEMBER_ONLY: ReadonlySet<GatewayTool> = new Set(["task_status"]);
const FORBIDDEN_KEYS =
  /^(base_?url|url|uri|href|host|hostname|origin|endpoint|server|proxy|token|access_?token|authorization|auth|bearer|credential|headers?|workspace_?id)$/i;

export type ScreenResult =
  { ok: true } | { ok: false; status: 403 | 422; errorCode: string; reasonCode: string };

/** Screens one JSON-RPC body before the MCP layer sees it. Only `tools/call` carries arguments. */
export function screenRequest(body: unknown): ScreenResult {
  if (Array.isArray(body))
    return { ok: false, status: 422, errorCode: "UNPROCESSABLE", reasonCode: "BATCH_NOT_SUPPORTED" };
  if (typeof body !== "object" || body === null)
    return { ok: false, status: 422, errorCode: "UNPROCESSABLE", reasonCode: "BAD_REQUEST" };
  const b = body as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (b.method !== "tools/call") return { ok: true };
  const name = b.params?.name;
  if (typeof name !== "string" || !(GATEWAY_TOOLS as readonly string[]).includes(name))
    return { ok: false, status: 422, errorCode: "UNPROCESSABLE", reasonCode: "UNKNOWN_TOOL" };
  const args = b.params?.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return { ok: false, status: 422, errorCode: "UNPROCESSABLE", reasonCode: "BAD_ARGUMENTS" };
  if (Object.keys(args).some((k) => FORBIDDEN_KEYS.test(k)))
    return {
      ok: false,
      status: 403,
      errorCode: "FORBIDDEN",
      reasonCode: "CLIENT_DEFINED_HOST_OR_CREDENTIAL",
    };
  if (!ARGS[name as GatewayTool].safeParse(args).success)
    return { ok: false, status: 422, errorCode: "UNPROCESSABLE", reasonCode: "INVALID_ARGUMENTS" };
  return { ok: true };
}

// ---- gateway credential: HS256, short-lived, audience-constrained, never the caller's token ----
const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");
export function mintGatewayToken(o: {
  secret: string;
  audience: string;
  scope: string;
  now?: Date;
  ttlSeconds?: number;
}): string {
  const iat = Math.floor((o.now ?? new Date()).getTime() / 1000);
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(
    JSON.stringify({
      iss: "nearesis-mcp-gateway",
      sub: "mcp-gateway",
      aud: o.audience,
      scope: o.scope,
      iat,
      exp: iat + (o.ttlSeconds ?? 60),
    }),
  );
  const sig = createHmac("sha256", o.secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${b64u(sig)}`;
}
export function verifyGatewayToken(
  token: string,
  secret: string,
  audience: string,
  now = new Date(),
): { ok: boolean; scope?: string } {
  const [h, b, s] = token.split(".");
  if (!h || !b || !s) return { ok: false };
  const want = createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url");
  if (want !== s) return { ok: false };
  const c = JSON.parse(Buffer.from(b, "base64url").toString("utf8")) as {
    aud?: string;
    exp?: number;
    scope?: string;
  };
  if (c.aud !== audience || typeof c.exp !== "number" || c.exp * 1000 < now.getTime()) return { ok: false };
  return { ok: true, scope: c.scope ?? "" };
}

export interface Downstream {
  /** Fixed at construction. Must be http(s) on a loopback host or one of `allowedHosts`. No credentials in the URL. */
  baseUrl: string;
  allowedHosts?: string[];
  audience: string;
  secret: string;
  fetch?: typeof fetch;
}

export function validateDownstream(d: Downstream): URL {
  const u = new URL(d.baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || u.hostname === "::1";
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("downstream base URL must be http or https");
  if (u.username || u.password) throw new Error("downstream base URL must not carry credentials");
  if (!loopback && !(d.allowedHosts ?? []).includes(u.hostname))
    throw new Error("downstream host is not allowlisted");
  return u;
}

const ok = (v: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const err = (errorCode: string, reasonCode: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ errorCode, reasonCode, message }) }],
});

export interface GatewayOptions {
  capsuleRoot?: string;
  principal: GatewayPrincipal;
  downstream?: Downstream;
  onCall?: (e: { tool: string; principal: GatewayPrincipal; outcome: "ok" | "denied" | "error" }) => void;
}

export function createGatewayServer(opts: GatewayOptions): McpServer {
  const root = opts.capsuleRoot ?? process.env.NEARESIS_CAPSULE_DIR ?? join(APP_ROOT, ".data", "capsules");
  const base = opts.downstream ? validateDownstream(opts.downstream) : null;
  const server = new McpServer({ name: "nearesis-gateway", version: "1.0.0" });
  const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;
  const capsules = (): Array<{ id: string; dir: string }> =>
    existsSync(root)
      ? readdirSync(root)
          .sort()
          .filter(
            (id) =>
              /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id) && existsSync(join(root, id, "manifest.json")),
          )
          .map((id) => ({ id, dir: join(root, id) }))
      : [];

  function tool<S extends z.ZodRawShape>(
    name: GatewayTool,
    description: string,
    shape: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult> | CallToolResult,
  ): void {
    server.registerTool(
      name,
      {
        description: `${description} Scope: ${SCOPES[name].join(", ")}.`,
        inputSchema: shape,
        annotations: READ_ONLY,
        _meta: { scopes: SCOPES[name] },
      },
      (async (args: unknown) => {
        if (MEMBER_ONLY.has(name) && (opts.principal.kind !== "member" || !opts.principal.workspaceId)) {
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: "denied" });
          return err(
            "FORBIDDEN",
            "WORKSPACE_MEMBERSHIP_REQUIRED",
            "This operation needs an authenticated workspace member.",
          );
        }
        try {
          const r = await handler(args as z.infer<z.ZodObject<S>>);
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: r.isError ? "error" : "ok" });
          return r;
        } catch {
          opts.onCall?.({ tool: name, principal: opts.principal, outcome: "error" });
          return err("INTERNAL", "TOOL_FAILED", "The operation failed.");
        }
      }) as never,
    );
  }

  tool(
    "semantic_discover",
    "List the published metrics (id, label, unit) available to query, by capsule.",
    {},
    () =>
      ok({
        metrics: capsules().flatMap(({ id, dir }) => {
          const m = readManifest(dir);
          return m
            ? m.results.map((r) => ({ capsuleId: id, metricId: r.id, label: r.label, unit: r.unit }))
            : [];
        }),
      }),
  );

  tool(
    "semantic_query",
    "Read one published metric value by capsule and metric id. No SQL, no free-form expressions.",
    { capsuleId: ID, metricId: ID },
    ({ capsuleId, metricId }) => {
      const c = capsules().find((x) => x.id === capsuleId);
      const m = c ? readManifest(c.dir) : null;
      const r = m?.results.find((x) => x.id === metricId);
      return r
        ? ok({
            capsuleId,
            metricId,
            value: r.value,
            unit: r.unit,
            computation: r.computation,
            label: m!.label,
          })
        : err("NOT_FOUND", "METRIC_NOT_FOUND", "Metric not found.");
    },
  );

  tool(
    "evidence_search",
    "Search published claims by text. The text is matched against stored claims only; it is never interpreted.",
    { text: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).optional() },
    ({ text, limit }) => {
      const needle = text.toLowerCase();
      const hits = capsules()
        .flatMap(({ id, dir }) =>
          (readManifest(dir)?.claims ?? []).map((c) => ({
            capsuleId: id,
            claimId: c.id,
            claimClass: c.claimClass,
            text: c.text,
            resultIds: c.resultIds,
          })),
        )
        .filter((h) => h.text.toLowerCase().includes(needle))
        .slice(0, limit ?? 10);
      return ok({ hits });
    },
  );

  tool(
    "chart_preview",
    "A chart specification (series, units, range) for a capsule's frozen series.",
    { capsuleId: ID },
    ({ capsuleId }) => {
      const c = capsules().find((x) => x.id === capsuleId);
      if (!c) return err("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
      const { descriptor, raw } = loadSnapshot(join(c.dir, "snapshot"));
      const rows = raw.get(descriptor.series.file)!.toString("utf8").split("\n").filter(Boolean);
      const head = rows[0]!.split(",");
      const col = (name: string) => head.indexOf(name);
      const pts = (name: string) => rows.slice(1).map((l) => [l.split(",")[0]!, l.split(",")[col(name)]!]);
      const x = pts(descriptor.series.x.column);
      return ok({
        kind: "line",
        title: `${descriptor.series.x.name} and ${descriptor.series.y.name}`,
        label: descriptor.label,
        range: { from: x[0]![0], to: x[x.length - 1]![0] },
        series: [
          { name: descriptor.series.x.name, unit: descriptor.series.x.unit, points: x },
          {
            name: descriptor.series.y.name,
            unit: descriptor.series.y.unit,
            points: pts(descriptor.series.y.column),
          },
        ],
      });
    },
  );

  tool(
    "task_status",
    "Status of a run in the caller's own workspace, read from the platform API with the gateway's credential.",
    { runId: RUN_ID },
    async ({ runId }) => {
      if (!opts.downstream || !base)
        return err("UNAVAILABLE", "NO_DOWNSTREAM", "No downstream is configured.");
      const url = new URL(`/v1/runs/${runId}`, base);
      if (url.origin !== base.origin) return err("FORBIDDEN", "ORIGIN_MISMATCH", "Refused.");
      const token = mintGatewayToken({
        secret: opts.downstream.secret,
        audience: opts.downstream.audience,
        scope: "runs:read",
      });
      const res = await (opts.downstream.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "x-workspace-id": opts.principal.workspaceId!,
          accept: "application/json",
        },
      });
      if (res.status === 404) return err("NOT_FOUND", "RUN_NOT_FOUND", "Run not found.");
      if (!res.ok) return err("UPSTREAM", "UPSTREAM_ERROR", `Downstream answered ${res.status}.`);
      const j = (await res.json()) as { id?: string; status?: string; updatedAt?: string };
      return ok({ runId, status: j.status ?? "unknown", updatedAt: j.updatedAt ?? null });
    },
  );

  tool(
    "capsule_verify",
    "Recompute a capsule's hashes and metrics locally. Offline; labelled local, never an OutLayer proof.",
    { capsuleId: ID },
    async ({ capsuleId }) => {
      const c = capsules().find((x) => x.id === capsuleId);
      if (!c) return err("NOT_FOUND", "CAPSULE_NOT_FOUND", "Capsule not found.");
      const r = await verifyCapsule(c.dir, { research: "skip", wasm: "skip" });
      return ok({
        scope: "local",
        status: r.status,
        reportStatus: r.reportStatus,
        failures: r.failures,
        checks: r.checks,
      });
    },
  );

  return server;
}

export interface GatewayHttpOptions {
  port?: number;
  host?: string;
  capsuleRoot?: string;
  downstream?: Downstream;
  /** Bearer token to principal. A missing or unknown token is the public principal. */
  tokens?: Record<string, GatewayPrincipal>;
  maxBodyBytes?: number;
}

export async function startGatewayHttp(
  o: GatewayHttpOptions = {},
): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const host = o.host ?? "127.0.0.1";
  const maxBody = o.maxBodyBytes ?? 32_768;
  const principalOf = (req: IncomingMessage): GatewayPrincipal => {
    const t = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
    return (t && o.tokens?.[t]) || PUBLIC_PRINCIPAL;
  };
  const reply = (res: import("node:http").ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const http = createServer((req, res) => {
    void (async () => {
      const hostHeader = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostHeader))
        return void reply(res, 403, { errorCode: "FORBIDDEN", reasonCode: "HOST_NOT_ALLOWED" });
      if (req.url?.split("?")[0] !== "/mcp" || req.method !== "POST")
        return void res.writeHead(req.url?.split("?")[0] === "/mcp" ? 405 : 404, { allow: "POST" }).end();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > maxBody)
          return void reply(res, 413, { errorCode: "PAYLOAD_TOO_LARGE", reasonCode: "BODY_TOO_LARGE" });
        chunks.push(c as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return void reply(res, 400, { errorCode: "BAD_REQUEST", reasonCode: "INVALID_JSON" });
      }
      const s = screenRequest(body);
      if (!s.ok) return void reply(res, s.status, { errorCode: s.errorCode, reasonCode: s.reasonCode });
      const mcp = createGatewayServer({
        principal: principalOf(req),
        ...(o.capsuleRoot ? { capsuleRoot: o.capsuleRoot } : {}),
        ...(o.downstream ? { downstream: o.downstream } : {}),
      });
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => http.listen(o.port ?? 0, host, r));
  const addr = http.address();
  return {
    server: http,
    port: typeof addr === "object" && addr ? addr.port : 0,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Process entry: configuration comes from the environment. Secrets are never printed.
  const tokens = process.env.NEARESIS_MCP_GATEWAY_TOKENS
    ? (JSON.parse(process.env.NEARESIS_MCP_GATEWAY_TOKENS) as Record<string, GatewayPrincipal>)
    : undefined;
  const downstream =
    process.env.NEARESIS_MCP_DOWNSTREAM_URL && process.env.NEARESIS_MCP_GATEWAY_SECRET
      ? {
          baseUrl: process.env.NEARESIS_MCP_DOWNSTREAM_URL,
          audience: process.env.NEARESIS_MCP_DOWNSTREAM_AUDIENCE ?? "nearesis-api",
          secret: process.env.NEARESIS_MCP_GATEWAY_SECRET,
        }
      : undefined;
  const { port } = await startGatewayHttp({
    port: Number(process.env.NEARESIS_MCP_GATEWAY_PORT ?? 4751),
    ...(tokens ? { tokens } : {}),
    ...(downstream ? { downstream } : {}),
  });
  console.log(JSON.stringify({ msg: "nearesis MCP gateway (read-only) listening", host: "127.0.0.1", port }));
}

import { z } from "zod";
import { CONTRACTS_VERSION, ErrorResponse } from "./common.ts";
import { API_STATE_INFO, DataStateEnvelope } from "./openapi-states.ts";
import type { ApiState } from "./openapi-states.ts";
import { SSE_EVENTS, SSE_SCHEMAS, SSE_SEMANTICS } from "./openapi-sse.ts";

/**
 * OpenAPI 3.1 generation from the zod contracts (final_master_prompt s21). `buildOpenApi` is pure: the API package owns
 * the route table (`apps/api/src/openapi-routes.ts`) and a test fails when a real route is missing from it or the
 * committed `docs/api/openapi.json` differs from what this function produces.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface ResponseSpec {
  description: string;
  schema?: z.ZodType;
  /** Defaults to application/json. */
  contentType?: string;
  /** Name of a file under docs/api/examples (without directory), shown in the spec as `x-example-file`. */
  exampleFile?: string;
  /** Set when the response body is not described by a zod contract (the route returns a service object). */
  untyped?: boolean;
  headers?: Record<string, { description: string; schema: Record<string, unknown> }>;
}

export interface RouteSpec {
  method: HttpMethod;
  /** Fastify path syntax (`/v1/workspaces/:id`). */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** `bearer` (session), `gateway` (MCP gateway credential), `none`. */
  auth: "bearer" | "gateway" | "none";
  /** Minimum role for mutations, when higher than member. */
  role?: "member" | "writer" | "admin" | "owner";
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Request headers beyond Authorization. */
  headers?: Array<{ name: string; description: string; required?: boolean }>;
  responses: Record<string, ResponseSpec>;
  /** Taxonomy states this route can return or stream. */
  states?: ApiState[];
  /** Spec section 21 capability this route serves. */
  capability?: string;
  /** Route exists only when this is configured, e.g. gateway credential. */
  conditional?: string;
}

export interface NamedSchema {
  name: string;
  schema: z.ZodType;
}

const toOasPath = (p: string) => p.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\/\*$/, "/{path}");
const paramNames = (p: string) =>
  [...p.matchAll(/:([A-Za-z_]+)/g)].map((m) => m[1]!).concat(p.endsWith("/*") ? ["path"] : []);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const operationIdOf = (r: Pick<RouteSpec, "method" | "path">) =>
  r.method +
  r.path
    .replace(/^\/v1/, "")
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith(":")
        ? `By${cap(seg.slice(1))}`
        : seg === "*"
          ? "Path"
          : seg.split(/[-_.]/).map(cap).join(""),
    )
    .join("");

type Json = Record<string, unknown>;

/** Names of schemas that are used both as a request body and as a response: the request copy is suffixed `Input`. */
function collectComponents(
  routes: readonly RouteSpec[],
  extra: readonly NamedSchema[],
  known: readonly NamedSchema[],
): { components: Record<string, Json>; nameOf(s: z.ZodType, side: "in" | "out"): string } {
  const reqIds = new Map<z.ZodType, string>();
  const resIds = new Map<z.ZodType, string>();
  const taken = new Set<string>();
  const claim = (base: string) => {
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base}${i}`;
    taken.add(n);
    return n;
  };
  const named = new Map<z.ZodType, string>();
  for (const e of known) named.set(e.schema, e.name);
  for (const e of extra) named.set(e.schema, e.name);
  const idFor = (s: z.ZodType, side: "in" | "out", hint: string): string => {
    const m = side === "in" ? reqIds : resIds;
    let id = m.get(s);
    if (id) return id;
    const nm = named.get(s);
    id = claim(nm ? (side === "in" && resIds.has(s) ? `${nm}Input` : nm) : hint);
    m.set(s, id);
    return id;
  };
  for (const e of extra) idFor(e.schema, "out", e.name);
  for (const r of routes) {
    const op = operationIdOf(r);
    if (r.query) idFor(r.query, "in", `${cap(op)}Query`);
    if (r.body) idFor(r.body, "in", `${cap(op)}Request`);
    for (const [status, resp] of Object.entries(r.responses))
      if (resp.schema) idFor(resp.schema, "out", `${cap(op)}Response${status}`);
  }
  const mk = (ids: Map<z.ZodType, string>, io: "input" | "output") => {
    const reg = z.registry<{ id: string }>();
    for (const [s, id] of ids) reg.add(s, { id });
    return z.toJSONSchema(reg, {
      target: "draft-2020-12",
      io,
      unrepresentable: "any",
      reused: "inline",
      uri: (id: string) => `#/components/schemas/${id}`,
    }).schemas as Record<string, Json>;
  };
  const components: Record<string, Json> = {};
  for (const [id, js] of Object.entries(mk(reqIds, "input"))) components[id] = js;
  for (const [id, js] of Object.entries(mk(resIds, "output"))) components[id] = js;
  // Recursive schemas land in zod's `__shared.$defs`: publish each def as its own component and point the refs at it.
  const shared = components.__shared as { $defs?: Record<string, Json> } | undefined;
  delete components.__shared;
  const hoisted = new Map<string, string>();
  for (const [defName, def] of Object.entries(shared?.$defs ?? {})) {
    const name = `Recursive${defName.replace(/^schema/, "")}`;
    hoisted.set(`#/components/schemas/__shared#/$defs/${defName}`, `#/components/schemas/${name}`);
    components[name] = def;
  }
  const fix = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") {
      const out: Json = {};
      for (const [k, x] of Object.entries(v as Json)) {
        if (k === "$schema" || k === "$id") continue;
        out[k] = k === "$ref" && typeof x === "string" ? (hoisted.get(x) ?? x) : fix(x);
      }
      return out;
    }
    return v;
  };
  for (const k of Object.keys(components)) {
    delete components[k]!.id; // registry metadata at the schema root only (never a property named id)
    components[k] = fix(components[k]) as Json;
  }
  return {
    components: Object.fromEntries(Object.entries(components).sort(([a], [b]) => (a < b ? -1 : 1))),
    nameOf: (s, side) => (side === "in" ? reqIds : resIds).get(s)!,
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export interface BuildOptions {
  routes: readonly RouteSpec[];
  /** Extra named schemas published in components (taxonomy, SSE frames, ...). */
  schemas?: readonly NamedSchema[];
  /** Every contract export, by name: a schema used by a route is published under its export name instead of a generated one. */
  known?: readonly NamedSchema[];
  servers?: Array<{ url: string; description: string }>;
}

export function buildOpenApi(o: BuildOptions) {
  const sse = Object.entries(SSE_SCHEMAS).map(([name, schema]) => ({ name, schema }) as NamedSchema);
  const extra: NamedSchema[] = [
    { name: "ErrorResponse", schema: ErrorResponse },
    { name: "DataStateEnvelope", schema: DataStateEnvelope },
    ...sse,
    ...(o.schemas ?? []),
  ];
  const { components, nameOf } = collectComponents(o.routes, extra, o.known ?? []);

  const paths: Record<string, Record<string, Json>> = {};
  const sorted = [...o.routes].sort((a, b) =>
    a.path === b.path ? (a.method < b.method ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  for (const r of sorted) {
    const parameters: Json[] = paramNames(r.path).map((n) => ({
      name: n,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (r.query) {
      const qn = nameOf(r.query, "in");
      const qs = components[qn] as { properties?: Record<string, Json>; required?: string[] };
      for (const [k, v] of Object.entries(qs.properties ?? {}))
        parameters.push({ name: k, in: "query", required: (qs.required ?? []).includes(k), schema: v });
    }
    for (const h of r.headers ?? [])
      parameters.push({
        name: h.name,
        in: "header",
        required: h.required ?? false,
        description: h.description,
        schema: { type: "string" },
      });
    const responses: Record<string, Json> = {};
    for (const [status, resp] of Object.entries(r.responses)) {
      const ct = resp.contentType ?? "application/json";
      responses[status] = {
        description: resp.description,
        ...(resp.headers ? { headers: resp.headers } : {}),
        ...(resp.schema || resp.contentType
          ? {
              content: {
                [ct]: {
                  schema: resp.schema ? ref(nameOf(resp.schema, "out")) : { type: "string" },
                },
              },
            }
          : {}),
        ...(resp.untyped ? { "x-schema-status": "untyped" } : {}),
        ...(resp.exampleFile ? { "x-example-file": `docs/api/examples/${resp.exampleFile}` } : {}),
      };
    }
    // Every operation can return the structured error body; list the shared ones once per operation.
    const errs: Array<[string, string, ApiState | undefined]> = [];
    if (r.auth !== "none")
      errs.push([
        "401",
        "Unauthenticated: missing, invalid, expired or revoked session.",
        "permission_denied",
      ]);
    if (r.auth !== "none")
      errs.push(["403", "Forbidden: role, origin or classification denies the action.", "permission_denied"]);
    if (r.path.includes(":id"))
      errs.push([
        "404",
        "Not found. A workspace the caller cannot access is the same 404 as one that does not exist.",
        undefined,
      ]);
    if (r.method !== "get")
      errs.push([
        "422",
        "Validation failed or a domain invariant refused the change; `details` lists paths.",
        undefined,
      ]);
    errs.push([
      "429",
      "Rate limited or overloaded. `Retry-After` header and `retryAfterSeconds`.",
      "rate_limited",
    ]);
    if (r.method !== "get")
      errs.push(["409", "Stale version or revision; reload and retry (`lastStableRevision`).", undefined]);
    for (const [st, desc] of errs)
      if (!responses[st])
        responses[st] = {
          description: desc,
          content: { "application/json": { schema: ref("ErrorResponse") } },
        };
    const bodySchema = r.body ? ref(nameOf(r.body, "in")) : null;
    (paths[toOasPath(r.path)] ??= {})[r.method] = {
      operationId: operationIdOf(r),
      tags: [r.tag],
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      ...(r.auth === "none"
        ? { security: [] }
        : r.auth === "gateway"
          ? { security: [{ gatewayCredential: [] }] }
          : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(bodySchema
        ? { requestBody: { required: true, content: { "application/json": { schema: bodySchema } } } }
        : {}),
      responses,
      ...(r.role ? { "x-min-role": r.role } : {}),
      ...(r.states?.length ? { "x-states": r.states } : {}),
      ...(r.capability ? { "x-capability": r.capability } : {}),
      ...(r.conditional ? { "x-conditional": r.conditional } : {}),
    };
  }

  const tagSet = [...new Set(sorted.map((r) => r.tag))].sort();
  return {
    openapi: "3.1.0",
    info: {
      title: "Nearesis API",
      version: CONTRACTS_VERSION,
      description:
        "Backend contracts for the Nearesis frontend. Generated from the zod contracts in packages/contracts; do not edit by hand (`pnpm api:openapi`). Every error uses ErrorResponse; every non-error data response can be described by the twelve ApiState values.",
    },
    servers: o.servers ?? [{ url: "http://localhost:4110", description: "Local development API" }],
    security: [{ bearerAuth: [] }],
    tags: tagSet.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "Session token from the identity policy (dev: POST /v1/dev/login).",
        },
        gatewayCredential: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Short-lived HS256 credential minted for the MCP gateway; audience-constrained.",
        },
      },
      schemas: components,
    },
    "x-api-states": Object.fromEntries(Object.entries(API_STATE_INFO).map(([k, v]) => [k, v])),
    "x-sse": {
      ...SSE_SEMANTICS,
      events: SSE_EVENTS.map((e) => ({ ...e, schemaRef: `#/components/schemas/${e.schema}` })),
    },
    "x-websocket": {
      path: "/v1/workspaces/{id}/collab/{scope}/ws",
      purpose:
        "Yjs collaboration transport (ch.11: WebSocket only for Yjs). Not an HTTP route: it is an HTTP Upgrade handled by collab-ws.ts.",
      auth: "Authorization bearer header, or the subprotocol `nearesis.bearer.<token>` for browsers.",
      frames: {
        "server->client": [
          "sync {update,cursor,readOnly}",
          "update {scope,cursor,update}",
          "presence {scope,peers}",
          "ack {cursor}",
          "error {code,reasonCode}",
        ],
        "client->server": ["update {update: base64 Yjs update}", "presence {state}", "sync"],
      },
      closeCodes: { "4403": "membership revoked", "4400": "bad frame" },
      refusals:
        "401 without a valid session; the same 404 for foreign and unknown workspaces (before any frame).",
    },
  };
}

export type OpenApiDocument = ReturnType<typeof buildOpenApi>;

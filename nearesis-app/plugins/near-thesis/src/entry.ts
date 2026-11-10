/**
 * near-thesis plugin entrypoint (loaded in-process by the kernel PluginManager). Handlers receive a kernel-built
 * InvocationContext; tenant/workspace/principal come from there, never from the input (S14, ch.20).
 */
import { Redis } from "ioredis";
import { type DataFrameEnvelope, type MetricMetadata, SemanticQuery } from "@nearesis/contracts";
import {
  compileVisualization,
  type FieldInfo,
  type QueryResultShape,
  type VizRequest,
} from "@nearesis/canvas-schema";
import { CUBE_URL_DEFAULT, defaultCubeSecret, loadRegistry, type Registry } from "@nearesis/analytics";
import { createGateway, DEFAULT_POLICY, type Session } from "@nearesis/semantic-gateway";
import { definePlugin, type InvocationContext } from "@nearesis/plugin-sdk";
import { PreviewInput } from "./capabilities.ts";

type Gateway = ReturnType<typeof createGateway>;
let gw: { gateway: Gateway; registry: Registry; redis: Redis } | null = null;

/** Lazily wires the gateway from server-side configuration (env), so importing the module has no side effects. */
export function gateway(): { gateway: Gateway; registry: Registry } {
  if (!gw) {
    const registry = loadRegistry();
    const redis = new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
      maxRetriesPerRequest: 2,
      lazyConnect: false,
    });
    gw = {
      registry,
      redis,
      gateway: createGateway({
        cubeUrl: process.env.CUBE_URL ?? CUBE_URL_DEFAULT,
        cubeSecret: defaultCubeSecret(),
        redis: redis as never,
        registry,
        policyResolver: () => ({ ...DEFAULT_POLICY }),
        clock: () => new Date(),
      }),
    };
  }
  return gw;
}

export function sessionOf(ctx: InvocationContext): Session {
  return {
    tenantId: ctx.principal.orgId,
    workspaceId: ctx.workspaceId,
    principalId: ctx.principal.actorId,
    aclClasses: [ctx.principal.kind],
  };
}

/** Field roles/units for the canvas compiler, derived from the envelope's typed columns. */
export function shapeOf(env: DataFrameEnvelope, grain: QueryResultShape["grain"]): QueryResultShape {
  const fields: FieldInfo[] = env.columns.map((c) => ({
    name: c.name,
    unit: c.unit,
    role: c.type === "time" ? "time" : c.type === "number" || c.type === "decimal" ? "measure" : "dimension",
    // Quote views bucket by sample time (fetchedAt), never settlement time (C17); other views use event time.
    ...(c.type === "time"
      ? {
          timeSemantics:
            /fetched_at/.test(c.name) || c.name.startsWith("quotes.")
              ? ("fetched_at" as const)
              : ("event_time" as const),
        }
      : {}),
    ...(c.type === "number" || c.type === "decimal" ? { metricId: c.name } : {}),
  }));
  return { queryHash: env.queryHash, grain, fields };
}

export function completenessOf(env: DataFrameEnvelope): "complete" | "partial" | "unavailable" {
  if (!env.rows.length) return env.gaps.length ? "unavailable" : "complete";
  return env.partialCount || env.nullCount || env.gaps.length || env.certification !== "certified"
    ? "partial"
    : "complete";
}

export default definePlugin({
  handlers: {
    "semantic.discover@1": async (_input, ctx) => {
      const r = await gateway().gateway.discover(sessionOf(ctx));
      return { ok: true, ...r };
    },
    "semantic.query@1": async (input, ctx) => {
      const r = await gateway().gateway.query(sessionOf(ctx), input);
      return r.ok
        ? { ok: true, queryHash: r.queryHash, cache: r.cache, envelope: r.envelope }
        : { ok: false, status: r.status, error: r.error };
    },
    /**
     * Pure preview for the composer: run each request's semantic query (read-only, cached path), compile the chart
     * with the certified catalog, and return one CanvasPatch (or per-request issues). Nothing is persisted (C11a).
     */
    "canvas.preview@1": async (input, ctx) => {
      const parsed = PreviewInput.parse(input);
      const { gateway: g, registry } = gateway();
      const metrics = registry.metrics as unknown as MetricMetadata[];
      const issues: Array<{ index: number; code: string; path: string; message: string }> = [];
      const ops = [];
      for (const [index, raw] of parsed.requests.entries()) {
        const ast = SemanticQuery.safeParse(raw.query);
        if (!ast.success) {
          issues.push({
            index,
            code: "SCHEMA_INVALID",
            path: "query",
            message: ast.error.issues[0]?.message ?? "invalid",
          });
          continue;
        }
        const q = await g.query(sessionOf(ctx), ast.data);
        if (!q.ok) {
          issues.push({
            index,
            code: q.error.reasonCode ?? q.error.errorCode,
            path: "query",
            message: q.error.message,
          });
          continue;
        }
        const req = {
          ...(raw as Omit<VizRequest, "query" | "result" | "completeness">),
          query: {
            hash: q.queryHash,
            semanticVersion: q.envelope.semanticVersion,
            grain: ast.data.time.grain,
          },
          result: shapeOf(q.envelope, ast.data.time.grain),
          completeness: completenessOf(q.envelope),
        } as VizRequest;
        const c = compileVisualization(req, metrics);
        if (!c.ok)
          for (const i of c.issues) issues.push({ index, code: i.code, path: i.path, message: i.message });
        else ops.push({ op: "addPanel" as const, panel: c.value.panel });
      }
      const ok = issues.length === 0;
      return {
        ok,
        patch: ok
          ? {
              schemaVersion: 1,
              type: "workspace.patch",
              operationId: crypto.randomUUID(),
              expectedRevision: parsed.expectedRevision,
              operations: ops,
            }
          : null,
        issues,
      };
    },
  },
  health: async () => {
    await gateway().gateway.discover({
      tenantId: "00000000-0000-4000-8000-000000000000",
      workspaceId: "00000000-0000-4000-8000-000000000000",
      principalId: "health",
      aclClasses: ["service"],
    });
  },
});

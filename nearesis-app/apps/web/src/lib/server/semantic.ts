import { Redis } from "ioredis";
import type { DataFrameEnvelope } from "@nearesis/contracts";
import {
  createCh,
  createPg,
  CUBE_URL_DEFAULT,
  defaultCubeSecret,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
  loadLiveRegistry,
  loadQuery,
  loadRegistry,
  type Registry,
} from "@nearesis/analytics";
import { createGateway, DEFAULT_POLICY, type Session } from "@nearesis/semantic-gateway";
import { fixtureHash, hasFixture } from "@nearesis/test-fixtures";
import { hashCanonical } from "@nearesis/canvas-schema";
import type { PanelData } from "../types.ts";
import { upstream, sessionToken } from "./upstream.ts";

/** Data source: SYNTHETIC fixture cubes (default, used by tests) or the LIVE real-data layer (cube-live, :4001). */
export type DataSource = "fixture" | "live";
export const parseSource = (v: string | null): DataSource => (v === "live" ? "live" : "fixture");

/** Server-side semantic access for the canvas BFF: the same guarded gateway agents use (no other query path). */
interface SemState {
  gateway: ReturnType<typeof createGateway>;
  registry: Registry;
  pg: ReturnType<typeof createPg>;
  ch: ReturnType<typeof createCh>;
}
const states: Partial<Record<DataSource, SemState>> = {};
let redisClient: Redis | null = null;
export function semantic(source: DataSource = "fixture"): SemState {
  const cached = states[source];
  if (cached) return cached;
  const live = source === "live";
  const registry = live ? loadLiveRegistry() : loadRegistry();
  const pg = createPg();
  const ch = live ? createCh({ database: LIVE_DATABASE }) : createCh();
  redisClient ??= new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
    maxRetriesPerRequest: 2,
  });
  const state: SemState = {
    registry,
    pg,
    ch,
    gateway: createGateway({
      cubeUrl: live
        ? (process.env.CUBE_LIVE_URL ?? LIVE_CUBE_URL_DEFAULT)
        : (process.env.CUBE_URL ?? CUBE_URL_DEFAULT),
      cubeSecret: defaultCubeSecret(),
      redis: redisClient as never,
      registry,
      policyResolver: () => ({ ...DEFAULT_POLICY }),
      clock: () => new Date(),
      pg,
      ch,
    }),
  };
  states[source] = state;
  return state;
}

/**
 * Session bound server-side: the kernel must confirm workspace membership for the cookie's token (404 otherwise);
 * tenant comes from the kernel's workspace projection and the principal from the verified token subject.
 */
export async function sessionFor(workspaceId: string): Promise<Session | null> {
  const token = await sessionToken();
  if (!token || !/^[0-9a-f-]{36}$/.test(workspaceId)) return null;
  const r = await upstream(`/v1/workspaces/${workspaceId}`);
  if (!r.ok) return null;
  const ws = (await r.json()) as { orgId: string };
  const sub = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    sub?: string;
  };
  return { tenantId: ws.orgId, workspaceId, principalId: sub.sub ?? "unknown", aclClasses: ["human"] };
}

export async function panelData(
  session: Session,
  queryHash: string,
  source: DataSource = "fixture",
): Promise<{ status: number; body: PanelData | unknown }> {
  const s = semantic(source);
  const saved = await loadQuery(s.pg, queryHash);
  if (!saved) return { status: 404, body: { errorCode: "NOT_FOUND", reasonCode: "QUERY_UNKNOWN" } };
  const r = await s.gateway.query(session, saved.ast);
  if (!r.ok) return { status: r.status, body: r.error };
  return { status: 200, body: toPanelData(r.envelope, saved.ast, s.registry, source) };
}

function toPanelData(
  env: DataFrameEnvelope,
  ast: unknown,
  registry: Registry,
  source: DataSource,
): PanelData {
  const a = ast as { measures: string[]; time: { grain: "hour" | "day" | "week" | "month" } };
  const metrics = registry.metrics.filter((m) => a.measures.includes(m.cubeMember));
  const sources = [...new Set(metrics.flatMap((m) => m.sources.map((x) => x.split(":")[0]!)))];
  const snap = env.sourceSnapshotId;
  const rows = env.rows.map((r) => r.map((v) => (typeof v === "boolean" ? String(v) : v)));
  const newest =
    Object.values(env.sourceWatermarks)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  return {
    chart: {
      panelId: "00000000-0000-4000-8000-000000000000",
      queryHash: env.queryHash,
      dataRevision: 1,
      columns: env.columns.map((c) => ({ name: c.name, unit: c.unit })),
      rows,
      downsampling: { method: "none", originalPoints: rows.length },
      freshness:
        env.certification === "stale" ? "late" : env.partialCount || env.nullCount ? "partial" : "fresh",
      sourceWatermark: newest,
    },
    shape: {
      queryHash: env.queryHash,
      grain: a.time.grain,
      fields: env.columns.map((c) => ({
        name: c.name,
        unit: c.unit,
        role:
          c.type === "time" ? "time" : c.type === "number" || c.type === "decimal" ? "measure" : "dimension",
        ...(c.type === "number" || c.type === "decimal" ? { metricId: c.name } : {}),
      })),
    },
    provenance: {
      queryHash: env.queryHash,
      semanticVersion: env.semanticVersion,
      semanticModelHash: env.semanticModelHash,
      sourceSnapshotId: snap,
      rawManifestHash: snap && hasFixture(snap) ? fixtureHash(snap) : null,
      certification: env.certification,
      ast,
      sourceLabel: source === "live" ? "LIVE" : snap?.startsWith("fx.") ? "SYNTHETIC" : "LIVE",
      resultHash: hashCanonical({ columns: env.columns, rows: env.rows }),
      sources,
    },
    gaps: env.gaps,
  };
}

/** Current source watermark states (ReplacingMergeTree read with FINAL). */
export async function watermarks(
  source: DataSource = "fixture",
): Promise<Record<string, { state: string; newestEventTime: string | null }>> {
  const rs = await semantic(source).ch.query({
    query: "SELECT provider_id, state, newest_event_time FROM source_watermarks FINAL",
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as Array<{
    provider_id: string;
    state: string;
    newest_event_time: string | null;
  }>;
  return Object.fromEntries(
    rows.map((r) => [r.provider_id, { state: r.state, newestEventTime: r.newest_event_time }]),
  );
}

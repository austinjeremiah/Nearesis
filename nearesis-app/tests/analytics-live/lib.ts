/**
 * Shared helpers for the live analytics verification (read-only against the live stack):
 *  - the PUBLIC application path: dev login on the API (4110), then the web BFF panel route (3300) with the session cookie
 *  - raw reference reads from `nearesis_live` (ClickHouse, FINAL) to reconcile against
 *  - an in-process gateway built exactly like the web BFF builds it (same code, Cube-live 4001, shared Redis), used where the
 *    BFF projection drops fields the envelope carries (per-row coverage, generatedAt, cost estimate)
 */
import { createRequire } from "node:module";
import {
  createCh,
  createPg,
  defaultCubeSecret,
  LIVE_CUBE_URL_DEFAULT,
  LIVE_DATABASE,
  loadLiveRegistry,
  queryRows,
  saveQuery,
  type ClickHouseClient,
} from "../../services/analytics/src/index.ts";
import {
  createGateway,
  DEFAULT_POLICY,
  queryHashOf,
  validateQuery,
  type Policy,
  type Session,
} from "../../packages/semantic-gateway/src/index.ts";

// ioredis is a dependency of services/analytics, not of the repo root: resolve it from there.
const req = createRequire(new URL("../../services/analytics/package.json", import.meta.url));
const { Redis } = req(
  "ioredis",
) as typeof import("../../services/analytics/node_modules/ioredis/built/index.js");
type Redis = InstanceType<typeof Redis>;

export const API = process.env.NEARESIS_API_URL ?? "http://127.0.0.1:4110";
export const WEB = process.env.NEARESIS_WEB_URL ?? "http://127.0.0.1:3300";
export const LIVE_CUBE = process.env.CUBE_LIVE_URL ?? LIVE_CUBE_URL_DEFAULT;
export const WORKSPACE = process.env.NEARESIS_LIVE_WORKSPACE ?? "17cd0234-3625-49b9-9daa-97293bb3ecd7";
export const OWNER_SUBJECT = "dev-owner";
export const REDIS_URL = process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379";

export const reg = loadLiveRegistry();
export const M = {
  swaps: "live.oneclick_swap_count",
  completed: "live.oneclick_completed_swap_count",
  usdKnown: "live.oneclick_usd_known_swap_count",
  usdUnknown: "live.oneclick_usd_unknown_swap_count",
  volume: "live.oneclick_volume_usd_known",
} as const;
export const TIME_FIELD = "intents_swaps_live.day";

export async function devLogin(subject: string): Promise<string> {
  const r = await fetch(`${API}/v1/dev/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ oidcSubject: subject }),
  });
  if (!r.ok) throw new Error(`dev login ${subject}: ${r.status} ${await r.text()}`);
  return ((await r.json()) as { token: string }).token;
}

export interface Ast {
  semanticVersion: string;
  measures: string[];
  dimensions: string[];
  filters: Array<{ member: string; operator: string; values: string[] }>;
  order: unknown[];
  limit: number;
  time: { field: string; from: string; to: string; grain: string };
}
export function liveAst(over: Partial<Ast> & { measures: string[] }, from: string, to: string): Ast {
  return {
    semanticVersion: reg.semanticVersion,
    dimensions: [],
    filters: [],
    order: [],
    limit: 10_000,
    time: { field: TIME_FIELD, from, to, grain: "day" },
    ...over,
  };
}

const pgPool = createPg();
export const closePg = () => pgPool.end();

/** Validates exactly as the gateway does, records the AST by hash (as an executed query would be), returns the hash. */
export async function registerAst(ast: Ast): Promise<string> {
  const v = validateQuery(ast, DEFAULT_POLICY, reg);
  if (!v.ok) throw new Error(`AST rejected: ${JSON.stringify(v.error)}`);
  const queryHash = queryHashOf(v.plan.ast);
  await saveQuery(pgPool, {
    queryHash,
    ast: v.plan.ast,
    semanticVersion: reg.semanticVersion,
    semanticModelHash: reg.contentHash,
  });
  return queryHash;
}

export interface PanelBody {
  chart: {
    queryHash: string;
    columns: Array<{ name: string; unit: string | null }>;
    rows: Array<Array<string | number | null>>;
    freshness: string;
    sourceWatermark: string | null;
  };
  provenance: { certification: string; resultHash: string; sourceLabel: string; semanticModelHash: string };
  gaps: Array<{ from: string; to: string; reason: string }>;
}
export async function panel(
  token: string,
  hash: string,
  workspace = WORKSPACE,
): Promise<{ status: number; body: PanelBody & Record<string, unknown>; ms: number }> {
  const t0 = performance.now();
  const r = await fetch(`${WEB}/api/semantic/panel/${hash}?workspace=${workspace}&source=live`, {
    headers: { cookie: `nearesis_session=${token}` },
  });
  const body = (await r.json()) as PanelBody & Record<string, unknown>;
  return { status: r.status, body, ms: performance.now() - t0 };
}

export const liveCh = (): ClickHouseClient => createCh({ database: LIVE_DATABASE });
export { queryRows };

export interface Raw {
  day: string;
  swaps: string;
  completed: string;
  usd_known: string;
  usd_unknown: string;
  volume: string | null;
}
/** Per-day raw truth from the base table (deduplicated with FINAL), optional extra predicate on status / era. */
export async function rawByDay(
  ch: ClickHouseClient,
  from: string,
  to: string,
  where = "1",
): Promise<Map<string, Raw>> {
  const rows = await queryRows<Raw>(
    ch,
    `SELECT toString(created_day) AS day, toString(count()) AS swaps, toString(countIf(status = 'SUCCESS')) AS completed,
            toString(countIf(amount_in_usd IS NOT NULL)) AS usd_known, toString(countIf(amount_in_usd IS NULL)) AS usd_unknown,
            if(countIf(amount_in_usd IS NOT NULL) = 0, NULL, toString(sumIf(amount_in_usd, amount_in_usd IS NOT NULL))) AS volume
     FROM intents_swaps FINAL
     WHERE created_day >= toDate({from:String}) AND created_day < toDate({to:String}) AND (${where})
     GROUP BY day ORDER BY day`,
    { from, to },
  );
  return new Map(rows.map((r) => [r.day, r]));
}

export interface LiveGw {
  gateway: ReturnType<typeof createGateway>;
  redis: Redis;
  ch: ClickHouseClient;
  close: () => Promise<void>;
}
/** Built like apps/web/src/lib/server/semantic.ts does for source=live (rollup-aware cost on by default). */
export function liveGateway(
  o: {
    rollupAwareCost?: boolean;
    policy?: Partial<Policy>;
    clock?: () => Date;
    cubeUrl?: string;
    warmRollups?: boolean;
    database?: string;
  } = {},
): LiveGw {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
  const ch = o.database ? createCh({ database: o.database }) : liveCh();
  const gateway = createGateway({
    cubeUrl: o.cubeUrl ?? LIVE_CUBE,
    cubeSecret: defaultCubeSecret(),
    redis: redis as never,
    registry: reg,
    policyResolver: () => ({ ...DEFAULT_POLICY, ...o.policy }),
    clock: o.clock ?? (() => new Date()),
    ch,
    readCacheMs: 0,
    ...(o.rollupAwareCost === undefined ? {} : { rollupAwareCost: o.rollupAwareCost }),
    ...(o.warmRollups === undefined ? {} : { warmRollups: o.warmRollups }),
  });
  return {
    gateway,
    redis,
    ch,
    close: async () => {
      await ch.close();
      redis.disconnect();
    },
  };
}
export const session = (tenant: string, workspace: string): Session => ({
  tenantId: tenant,
  workspaceId: workspace,
  principalId: "a16-probe",
  aclClasses: ["human"],
});

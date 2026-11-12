import type { DataFrameEnvelope, ErrorResponse, SemanticQuery } from "@nearesis/contracts";
import type { ClickHouseClient, Registry } from "@nearesis/analytics";

/** Resolved by the caller from the kernel session. Never taken from a request body. */
export interface Session {
  tenantId: string;
  workspaceId: string;
  principalId: string;
  aclClasses: string[];
}

export interface Policy {
  /** Restricted metric/dimension ids this workspace is granted. */
  grantedMembers: string[];
  /** Cost cap: estimated rows scanned (rows/day x days across involved datasets). */
  maxEstimatedRows: number;
  maxWindowDays: number;
  /** What to do with a week/month bucket that contains unavailable days. */
  incompleteWindow: "partial" | "refuse";
  cacheTtlSeconds: number;
}

export const DEFAULT_POLICY: Policy = {
  grantedMembers: [],
  maxEstimatedRows: 5_000_000,
  maxWindowDays: 3660,
  incompleteWindow: "partial",
  cacheTtlSeconds: 300,
};

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export interface GatewayOptions {
  cubeUrl: string;
  cubeSecret: string;
  redis: RedisLike;
  registry: Registry;
  policyResolver: (session: Session) => Policy | Promise<Policy>;
  clock: () => Date;
  /** ClickHouse client for coverage, vintage and cost probes (read-only, parameterized). Defaults to the dev stack. */
  ch?: ClickHouseClient;
  /** Optional Postgres pool: when set, every successful query AST is saved by hash to analytics_meta.query_registry. */
  pg?: import("pg").Pool;
  /**
   * How long (ms) source vintage, coverage, quality-gap, watermark and cost-rate reads are reused in-process (default
   * 5000, 0 disables). They only change on ingestion, so a Redis cache hit then costs one Redis read instead of about six
   * ClickHouse queries (FND-017). The cache key still embeds the vintage, so a result is never served across a vintage
   * change that this gateway has observed.
   */
  readCacheMs?: number;
  /** TTL of the per-source row-rate estimate (default 60 s; 0 when readCacheMs is 0). */
  rowRateCacheMs?: number;
}

export interface AuditRecord {
  at: string;
  traceId: string;
  queryHash: string;
  principalId: string;
  tenantId: string;
  workspaceId: string;
  /** The security context bound to the Cube call (always derived from the session). */
  boundContext: { tenantId: string; workspaceId: string; principalId: string; aclClasses: string[] };
  outcome: "executed" | "cache_hit" | "rejected";
  reasonCode?: string;
}

export interface QueryOk {
  ok: true;
  status: 200;
  queryHash: string;
  cache: "hit" | "miss";
  cacheKey: string;
  envelope: DataFrameEnvelope;
}
export interface QueryErr {
  ok: false;
  status: number;
  error: ErrorResponse;
}
export type QueryResult = QueryOk | QueryErr;

export interface CatalogResult {
  semanticVersion: string;
  semanticModelHash: string;
  metrics: Registry["metrics"];
  dimensions: Registry["dimensions"];
}

export interface GatewayStats {
  /** Cube /load executions. Rejected and cached queries never increment it (S03, S06, S14). */
  executions: number;
  cacheHits: number;
  cacheMisses: number;
  rejected: number;
  coverageProbes: number;
}

export type { SemanticQuery };

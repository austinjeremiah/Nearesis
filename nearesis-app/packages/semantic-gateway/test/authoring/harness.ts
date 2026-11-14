import pg from "pg";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthoredMetricStore,
  SERVICE_ROOT,
  createCh,
  migrate,
  migratePg,
  type ClickHouseClient,
} from "@nearesis/analytics";
import type { MetricProposal } from "@nearesis/contracts";
import {
  buildSourceCatalogue,
  createAuthoringService,
  type AuthoringPrincipal,
  type SourceCatalogue,
} from "../../src/authoring/index.ts";

/** Disposable ClickHouse database (live schema) and Postgres database for authoring tests. Nothing shared is touched. */
const auth = {
  url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
};
const LIVE_MIGRATIONS = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../services/ingestion/migrations-live",
);
void SERVICE_ROOT;

export const TENANT = "tenant-a";
export const WORKSPACE = "ws-1";
export const principal = (
  id: string,
  kind: AuthoringPrincipal["kind"],
  role: AuthoringPrincipal["role"],
  tenantId = TENANT,
): AuthoringPrincipal => ({ id, kind, role, tenantId, workspaceId: WORKSPACE });
export const AGENT = principal("agent-1", "agent", "analyst");
export const ANALYST = principal("analyst-1", "human", "analyst");
export const VIEWER = principal("viewer-1", "human", "viewer");
export const OWNER = principal("owner-1", "human", "owner");
export const ADMIN = principal("admin-1", "human", "admin");

export interface Harness {
  ch: ClickHouseClient;
  database: string;
  pool: pg.Pool;
  catalogue: SourceCatalogue;
  svc: ReturnType<typeof createAuthoringService>;
  store: AuthoredMetricStore;
  ins: (table: string, values: object[]) => Promise<unknown>;
  close: () => Promise<void>;
  now: { t: Date };
}

export const DAY0 = "2026-09-01";
export const DAYS = 45;
export const dayOf = (i: number) =>
  new Date(Date.parse(`${DAY0}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

export async function setup(opts: { catalogueEdit?: (c: SourceCatalogue) => void } = {}): Promise<Harness> {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const database = `nearesis_t_a19_${suffix}`;
  const admin = createCh({ ...auth, database: "default" });
  await admin.command({ query: `CREATE DATABASE ${database}` });
  const ch = createCh({ ...auth, database });
  await migrate(ch, LIVE_MIGRATIONS);

  const pgUrl = process.env.NEARESIS_PG_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";
  const pgName = `nearesis_t_a19_${suffix}`;
  const pgAdmin = new pg.Pool({ connectionString: pgUrl, max: 1 });
  await pgAdmin.query(`CREATE DATABASE ${pgName}`);
  const u = new URL(pgUrl);
  u.pathname = `/${pgName}`;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
  await migratePg(pool);

  const ins = (table: string, values: object[]) =>
    ch.insert({
      table,
      values,
      format: "JSONEachRow",
      clickhouse_settings: {
        input_format_defaults_for_omitted_fields: 1,
        date_time_input_format: "best_effort",
      },
    });
  // near_daily_tx: one row per day, plus a superseded older version of day 10 that FINAL must hide
  await ins("near_daily_tx", [
    ...Array.from({ length: DAYS }, (_, i) => ({
      block_date: dayOf(i),
      tx_count: 100 + i,
      distinct_signer_proxy: 10 + i,
      source_label: "FIXTURE",
      raw_object_hash: "h",
      fetched_at: `${dayOf(i)} 12:00:00`,
      version: 2,
    })),
    {
      block_date: dayOf(10),
      tx_count: 99999,
      distinct_signer_proxy: 99999,
      source_label: "FIXTURE",
      raw_object_hash: "h",
      fetched_at: `${dayOf(10)} 11:00:00`,
      version: 1,
    },
  ]);
  await ins(
    "intents_swaps",
    Array.from({ length: DAYS }, (_, i) =>
      [
        ["SUCCESS", "10.5"],
        ["SUCCESS", "20.25"],
        ["REFUNDED", "5"],
      ].map(([status, usd], j) => ({
        swap_key: `k-${i}-${j}`,
        created_at: `${dayOf(i)} 10:0${j}:00`,
        created_day: dayOf(i),
        status,
        amount_in_usd: usd,
        fetched_at: `${dayOf(i)} 12:00:00`,
        version: 1,
      })),
    ).flat(),
  );
  // coverage: complete everywhere except day 40 of near_daily_tx (partial) and day 41 of intents_swaps (unavailable)
  const cov = (provider: string, dataset: string, skip?: { i: number; state: string }) =>
    Array.from({ length: DAYS }, (_, i) => ({
      provider_id: provider,
      dataset,
      day: dayOf(i),
      state: skip && skip.i === i ? skip.state : "complete",
      reason: null,
      source_label: "FIXTURE",
      version: 1,
    }));
  await ins("source_coverage", [
    ...cov("near-bigquery", "near_daily_tx", { i: 40, state: "partial" }),
    ...cov("near-explorer", "intents_swaps", { i: 41, state: "unavailable" }),
  ]);

  const catalogue = await buildSourceCatalogue(ch, { database });
  opts.catalogueEdit?.(catalogue);
  const now = { t: new Date("2026-11-13T10:00:00Z") };
  const store = new AuthoredMetricStore(pool, () => now.t);
  const svc = createAuthoringService({ store, ch, catalogue: async () => catalogue, clock: () => now.t });
  return {
    ch,
    database,
    pool,
    catalogue,
    svc,
    store,
    ins,
    now,
    close: async () => {
      await pool.end();
      await pgAdmin.query(`DROP DATABASE IF EXISTS ${pgName} WITH (FORCE)`);
      await pgAdmin.end();
      await ch.close();
      await admin.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await admin.close();
    },
  };
}

/** A valid proposal: daily NEAR transactions, `tx`. Override fields per test. */
export function txPerDay(
  author: AuthoringPrincipal = AGENT,
  over: Partial<MetricProposal> = {},
): MetricProposal {
  return {
    schemaVersion: 1,
    namespace: "authored",
    name: "daily_tx_total",
    displayName: "Daily transactions",
    description: "Total NEAR transactions per UTC day from the deduplicated daily table.",
    sources: ["near_daily_tx"],
    joins: [],
    entityGrain: { kind: "global" },
    timeGrain: { column: { table: "near_daily_tx", column: "block_date" }, grain: "day" },
    dimensions: [],
    filters: [],
    aggregations: [{ id: "tx", fn: "sum", column: { table: "near_daily_tx", column: "tx_count" } }],
    unit: "tx",
    precision: { decimals: 0, rounding: "half_even" },
    nullSemantics: { nullInput: "ignore", emptyBucket: "null" },
    dedup: { strategy: "final" },
    historicalValidity: { validFrom: "2025-11-10", validTo: null, restatement: "may_restate" },
    costEstimate: { maxEstimatedRows: 100000 },
    dependencies: [],
    tests: [
      { kind: "reconcile_raw", name: "matches raw" },
      { kind: "non_negative", name: "no negatives" },
    ],
    limitations: ["Counts transactions as delivered by the daily source; later restatements change history."],
    version: 1,
    author: { principalId: author.id, kind: author.kind, tenantId: author.tenantId },
    ...over,
  };
}

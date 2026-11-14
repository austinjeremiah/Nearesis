import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type { ClickHouseClient };

export const SERVICE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Reads are always exact: 64-bit ints and decimals come back as JSON strings (S15), never through a float path. */
export const EXACT_READ_SETTINGS = {
  output_format_json_quote_64bit_integers: 1,
  output_format_json_quote_decimals: 1,
  output_format_json_quote_64bit_floats: 1,
} as const;

export interface ChOptions {
  url?: string;
  username?: string;
  password?: string;
  database?: string;
}

/** Dev-stack defaults (127.0.0.1:58123, nearesis/nearesis); overridable through NEARESIS_CH_* env. */
export function createCh(opts: ChOptions = {}): ClickHouseClient {
  return createClient({
    url: opts.url ?? process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
    username: opts.username ?? process.env.NEARESIS_CH_USER ?? "nearesis",
    password: opts.password ?? process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
    database: opts.database ?? process.env.NEARESIS_CH_DATABASE ?? "nearesis",
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
}

/** Parameterized read returning rows with every number as an exact string. Identifiers are never interpolated from input. */
export async function queryRows<T = Record<string, unknown>>(
  ch: ClickHouseClient,
  sql: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const rs = await ch.query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: EXACT_READ_SETTINGS,
  });
  return (await rs.json()) as T[];
}

export const MIGRATIONS_DIR = join(SERVICE_ROOT, "clickhouse", "migrations");

function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/** Applies versioned SQL files in order, tracked in `<database>.schema_migrations`. Idempotent. Returns applied versions. */
export async function migrate(ch: ClickHouseClient, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await ch.command({
    query: `CREATE TABLE IF NOT EXISTS schema_migrations (version String, applied_at DateTime64(3, 'UTC') DEFAULT now64(3)) ENGINE = MergeTree ORDER BY version`,
  });
  const done = new Set(
    (await queryRows<{ version: string }>(ch, "SELECT version FROM schema_migrations")).map((r) => r.version),
  );
  const applied: string[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()) {
    if (done.has(f)) continue;
    for (const stmt of statementsOf(readFileSync(join(dir, f), "utf8"))) await ch.command({ query: stmt });
    await ch.insert({ table: "schema_migrations", values: [{ version: f }], format: "JSONEachRow" });
    applied.push(f);
  }
  return applied;
}

/** Creates a disposable test database (`nearesis_t_b2_<rand>`), migrated, and returns a client bound to it plus a disposer. */
export async function createTestDb(): Promise<{
  ch: ClickHouseClient;
  database: string;
  drop: () => Promise<void>;
}> {
  const admin = createCh({ database: "default" });
  const database = `nearesis_t_b2_${Math.random().toString(36).slice(2, 10)}`;
  await admin.command({ query: `CREATE DATABASE ${database}` });
  const ch = createCh({ database });
  await migrate(ch);
  return {
    ch,
    database,
    drop: async () => {
      await ch.close();
      await admin.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await admin.close();
    },
  };
}

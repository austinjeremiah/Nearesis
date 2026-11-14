import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
export const DEFAULT_DATABASE_URL = "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";

export type Queryable = Pick<pg.Pool, "query">;

/** Thin pool wrapper. All Engine B objects live in schema `ingestion` (fully qualified in SQL). */
export class Db {
  readonly pool: pg.Pool;
  constructor(connectionString: string = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
    this.pool = new pg.Pool({ connectionString, max: 4 });
  }
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<R>(sql, params);
  }
  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Apply migrations/NNN_*.sql not yet recorded in ingestion.schema_migrations. Idempotent. */
export async function migrate(url: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727002)");
    await client.query("CREATE SCHEMA IF NOT EXISTS ingestion");
    await client.query(
      `CREATE TABLE IF NOT EXISTS ingestion.schema_migrations (
         version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ version: string }>("SELECT version FROM ingestion.schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    for (const f of readdirSync(dir)
      .filter((x) => /^\d{3}_.+\.sql$/.test(x))
      .sort()) {
      if (done.has(f)) continue;
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, f), "utf8"));
        await client.query("INSERT INTO ingestion.schema_migrations(version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727002)").catch(() => undefined);
    await client.end();
  }
  return applied;
}

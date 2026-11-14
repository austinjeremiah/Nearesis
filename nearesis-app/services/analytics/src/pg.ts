import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_ROOT } from "./ch.ts";

export const PG_MIGRATIONS_DIR = join(SERVICE_ROOT, "pg", "migrations");

export function createPg(): pg.Pool {
  return new pg.Pool({
    connectionString: process.env.NEARESIS_PG_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis",
    max: 4,
  });
}

/** Versioned SQL migrations, all objects in schema `analytics_meta`, tracked in analytics_meta.schema_migrations. */
export async function migratePg(pool?: pg.Pool): Promise<string[]> {
  const own = !pool;
  const p = pool ?? createPg();
  try {
    await p.query("CREATE SCHEMA IF NOT EXISTS analytics_meta");
    await p.query(
      "CREATE TABLE IF NOT EXISTS analytics_meta.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await p.query("SELECT version FROM analytics_meta.schema_migrations")).rows.map(
        (r) => r.version as string,
      ),
    );
    const applied: string[] = [];
    for (const f of readdirSync(PG_MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort()) {
      if (done.has(f)) continue;
      const c = await p.connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(join(PG_MIGRATIONS_DIR, f), "utf8"));
        await c.query("INSERT INTO analytics_meta.schema_migrations(version) VALUES ($1)", [f]);
        await c.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    return applied;
  } finally {
    if (own) await p.end();
  }
}

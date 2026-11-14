import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

/** Apply every NNN_name.sql not yet recorded in schema_migrations, each in its own transaction. Idempotent. */
export async function migrate(adminUrl: string, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map(
        (r) => r.version,
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(727001)");
    } finally {
      await client.end();
    }
  }
  return applied;
}

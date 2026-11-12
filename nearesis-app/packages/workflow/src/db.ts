import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** All runtime pools resolve unqualified names in schema `runtime` (never `public`). */
export function makePool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, options: "-c search_path=runtime" });
  // An idle client killed by a database restart or connection reset emits 'error' on the pool; without a listener that
  // is an uncaught exception that takes the whole worker down (found by PERF11). The pool replaces the client.
  pool.on("error", () => undefined);
  return pool;
}

export type { Pool, PoolClient } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, "..", "migrations");

export const DEFAULT_ADMIN_URL = "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";
export const DEFAULT_APP_URL = "postgres://nearesis_app:nearesis_app@127.0.0.1:55432/nearesis";

export function dbUrls(): { admin: string; app: string } {
  return {
    admin: process.env.DATABASE_URL ?? DEFAULT_ADMIN_URL,
    app: process.env.DATABASE_APP_URL ?? DEFAULT_APP_URL,
  };
}

/** Transaction with the tenant GUC set (RLS, `SELECT set_config('app.org_id', $1, true)`). */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  // A restart or reset while the client is checked out is an 'error' event on it; unhandled that kills the process.
  const onClientError = () => undefined;
  c.on("error", onClientError);
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.org_id', $1, true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.removeListener("error", onClientError);
    c.release();
  }
}

/** Idempotent migrator: own `workflow_migrations` table (the kernel keeps its own), each file in a transaction. */
export async function migrate(adminPool: pg.Pool): Promise<string[]> {
  await adminPool.query(
    "CREATE SCHEMA IF NOT EXISTS runtime; CREATE TABLE IF NOT EXISTS runtime.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    const c = await adminPool.connect();
    try {
      await c.query("SELECT pg_advisory_lock(7770001)");
      const done = await c.query("SELECT 1 FROM runtime.schema_migrations WHERE name = $1", [f]);
      if (done.rowCount) continue;
      await c.query("BEGIN");
      await c.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      await c.query("INSERT INTO runtime.schema_migrations (name) VALUES ($1)", [f]);
      await c.query("COMMIT");
      applied.push(f);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      await c.query("SELECT pg_advisory_unlock(7770001)").catch(() => undefined);
      c.release();
    }
  }
  return applied;
}

export interface TestDatabase {
  name: string;
  adminUrl: string;
  appUrl: string;
  admin: pg.Pool;
  app: pg.Pool;
  drop(): Promise<void>;
}

/** Creates an isolated database `nearesis_t_a3_<rand>`, migrates it, and returns admin + app pools. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const base = dbUrls();
  const root = new pg.Pool({ connectionString: base.admin, max: 1 });
  const name = `nearesis_t_a3_${randomBytes(5).toString("hex")}`;
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();
  const swap = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
  };
  const adminUrl = swap(base.admin);
  const appUrl = swap(base.app);
  const admin = makePool(adminUrl, 4);
  await migrate(admin);
  const app = makePool(appUrl, 12);
  return {
    name,
    adminUrl,
    appUrl,
    admin,
    app,
    async drop() {
      await app.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      const r = new pg.Pool({ connectionString: base.admin, max: 1 });
      await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await r.end();
    },
  };
}

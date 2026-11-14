import { randomBytes } from "node:crypto";
import pg from "pg";
import { DEFAULT_DATABASE_URL, Db, migrate } from "../db.ts";

export interface TestDb {
  db: Db;
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** Creates disposable database `nearesis_t_b1_<rand>`, migrated; `drop()` removes it. */
export async function createTestDb(): Promise<TestDb> {
  const admin = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const name = `nearesis_t_b1_${randomBytes(5).toString("hex")}`;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
  const u = new URL(admin);
  u.pathname = `/${name}`;
  const url = u.toString();
  await migrate(url);
  const db = new Db(url);
  return {
    db,
    url,
    name,
    async drop() {
      await db.close();
      const a = new pg.Client({ connectionString: admin });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

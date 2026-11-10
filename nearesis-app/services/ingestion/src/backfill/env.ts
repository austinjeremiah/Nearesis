import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEFAULT_DATABASE_URL, Db, migrate } from "../db.ts";
import { CredentialSource } from "../http/credentials.ts";
import { FsObjectStore } from "../archive/object-store.ts";
import { RawArchive } from "../archive/archive.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(here, "..", "..", "..", "..");
export const REPO_ROOT = join(APP_ROOT, "..");
export const DATA_DIR = join(APP_ROOT, ".data", "backfill");
export const STATE_PATH = join(DATA_DIR, "state.json");
export const RAW_DIR = join(DATA_DIR, "raw");
export const RUNS_DIR = join(REPO_ROOT, "NEARESIS_Build_Bible", "reports", "RUNS");
export const LIVE_PG_DATABASE = "nearesis_live";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:56379";

export const loadCredentials = (): CredentialSource => CredentialSource.fromDotenv(join(REPO_ROOT, ".env"));

/** Separate Postgres database for the live archive metadata and Explorer cursor state (the `nearesis` database is untouched). */
export async function openLivePg(name: string = LIVE_PG_DATABASE): Promise<{ db: Db; url: string }> {
  if (!/^nearesis_(live|t_a13_[a-z0-9]+)$/.test(name)) throw new Error("unexpected database name");
  const admin = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const c = new pg.Client({ connectionString: admin });
  await c.connect();
  try {
    const ex = await c.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (ex.rowCount === 0) await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }
  const u = new URL(admin);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  return { db: new Db(u.toString()), url: u.toString() };
}

export const openArchive = (db: Db | null, root: string = RAW_DIR): RawArchive =>
  new RawArchive(new FsObjectStore(root), db);

export const tempName = (): string => `nearesis_t_a13_${randomBytes(4).toString("hex")}`;

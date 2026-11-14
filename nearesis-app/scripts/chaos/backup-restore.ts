/**
 * Scripted Postgres + ClickHouse backup and VERIFIED restore (ch.21 "Restore drill", ch.17).
 *
 *   tsx scripts/chaos/backup-restore.ts backup  --pg-db <db> --ch-db <db> --out <dir> [--pg-container <name>] [--pg-port N] [--ch-url URL]
 *   tsx scripts/chaos/backup-restore.ts restore --dir <dir> --pg-db <newdb> --ch-db <newdb>
 *   tsx scripts/chaos/backup-restore.ts verify  --dir <dir> --pg-db <db> --ch-db <db>
 *
 * Backup: `pg_dump -Fc` of the database (run inside the Postgres container: read-only, ACCESS SHARE locks only) and, per
 * ClickHouse table, `SHOW CREATE TABLE` plus the rows in Native format. A manifest records per table the row count and a
 * content hash computed IN the database (md5 over the ordered row text for Postgres, sum(cityHash64(*)) for ClickHouse)
 * plus the sha256 of every backup file. Restore only ever writes to the isolated chaos stack (ports 64432 / 64123): it
 * refuses any other target. Verify recomputes counts and hashes on the restored databases and compares to the manifest.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PgTableSum {
  schema: string;
  table: string;
  rows: number;
  hash: string;
}
export interface ChTableSum {
  table: string;
  rows: number;
  hash: string;
  engine: string;
}
export interface Manifest {
  version: 1;
  createdAt: string;
  postgres: { database: string; dump: string; dumpSha256: string; tables: PgTableSum[] };
  clickhouse: {
    database: string;
    tables: Array<ChTableSum & { ddl: string; data: string; dataSha256: string }>;
  };
}

export interface Endpoints {
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgContainer: string;
  chUrl: string;
  chUser: string;
  chPassword: string;
}
export const ISOLATED_ENDPOINTS: Endpoints = {
  pgPort: 64432,
  pgUser: "nearesis",
  pgPassword: "nearesis",
  pgContainer: "nearesis-chaos-postgres-1",
  chUrl: "http://127.0.0.1:64123",
  chUser: "nearesis",
  chPassword: "nearesis",
};
const ISOLATED_PG_PORT = 64432;
const ISOLATED_CH_PORT = "64123";
const ident = (s: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return s;
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function guardRestoreTarget(e: Endpoints): void {
  if (
    e.pgPort !== ISOLATED_PG_PORT ||
    !e.pgContainer.startsWith("nearesis-chaos-") ||
    new URL(e.chUrl).port !== ISOLATED_CH_PORT
  )
    throw new Error("restore refused: the target is not the isolated nearesis-chaos stack");
}

const dockerExec = (container: string, args: string[], input?: Buffer) => {
  const r = spawnSync("docker", ["exec", "-i", container, ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`docker exec ${args[0]} failed: ${r.stderr?.toString().slice(0, 400)}`);
  return r.stdout;
};

async function chRaw(
  e: Endpoints,
  sql: string,
  opts: { body?: Buffer; format?: string; db?: string } = {},
): Promise<Buffer> {
  const u = new URL(e.chUrl);
  u.searchParams.set("query", sql + (opts.format ? ` FORMAT ${opts.format}` : ""));
  if (opts.db) u.searchParams.set("database", opts.db);
  const r = await fetch(u, {
    method: "POST",
    headers: { "x-clickhouse-user": e.chUser, "x-clickhouse-key": e.chPassword },
    ...(opts.body ? { body: new Uint8Array(opts.body) } : {}),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) throw new Error(`clickhouse ${r.status}: ${buf.toString().slice(0, 300)}`);
  return buf;
}
const chJson = async (e: Endpoints, sql: string, db?: string) =>
  (
    JSON.parse((await chRaw(e, sql, { format: "JSON", ...(db ? { db } : {}) })).toString()) as {
      data: Array<Record<string, string>>;
    }
  ).data;

/** Runs SQL through psql inside the Postgres container (no host client needed); returns unaligned tuples. */
const psql = (e: Endpoints, db: string, sql: string): string[][] =>
  dockerExec(e.pgContainer, [
    "psql",
    "-U",
    e.pgUser,
    "-d",
    db,
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-F",
    "\t",
    "-c",
    sql,
  ])
    .toString()
    .split("\n")
    .filter((l) => l.length)
    .map((l) => l.split("\t"));

export async function pgSums(e: Endpoints, db: string): Promise<PgTableSum[]> {
  const out: PgTableSum[] = [];
  for (const [schema, table] of psql(
    e,
    db,
    "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2",
  )) {
    const q = `"${ident(schema!)}"."${ident(table!)}"`;
    const [n, h] = psql(
      e,
      db,
      `SELECT count(*)::text, COALESCE(md5(string_agg(x::text, '|' ORDER BY x::text)), md5('')) FROM ${q} x`,
    )[0]!;
    out.push({ schema: schema!, table: table!, rows: Number(n), hash: h! });
  }
  return out;
}

export async function chSums(e: Endpoints, db: string): Promise<ChTableSum[]> {
  const tables = await chJson(
    e,
    `SELECT name, engine FROM system.tables WHERE database='${ident(db)}' AND NOT is_temporary AND engine NOT LIKE '%View' ORDER BY name`,
  );
  const out: ChTableSum[] = [];
  for (const t of tables) {
    const s = await chJson(
      e,
      `SELECT toString(count()) AS n, toString(sum(cityHash64(*))) AS h FROM \`${ident(db)}\`.\`${ident(t.name!)}\``,
    );
    out.push({ table: t.name!, rows: Number(s[0]!.n), hash: s[0]!.h!, engine: t.engine! });
  }
  return out;
}

export async function backup(a: {
  pgDb: string;
  chDb: string;
  out: string;
  src?: Endpoints;
}): Promise<Manifest> {
  const e = a.src ?? ISOLATED_ENDPOINTS;
  mkdirSync(a.out, { recursive: true });
  const dumpFile = join(a.out, "postgres.dump");
  const dump = dockerExec(e.pgContainer, ["pg_dump", "-Fc", "-U", e.pgUser, "-d", ident(a.pgDb)]);
  writeFileSync(dumpFile, dump);
  const m: Manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    postgres: {
      database: a.pgDb,
      dump: "postgres.dump",
      dumpSha256: sha(dump),
      tables: await pgSums(e, a.pgDb),
    },
    clickhouse: { database: a.chDb, tables: [] },
  };
  for (const t of await chSums(e, a.chDb)) {
    const ddl = (await chJson(e, `SHOW CREATE TABLE \`${ident(a.chDb)}\`.\`${ident(t.table)}\``))[0]!
      .statement!;
    const data = await chRaw(e, `SELECT * FROM \`${ident(a.chDb)}\`.\`${ident(t.table)}\``, {
      format: "Native",
    });
    const f = `ch.${t.table}.native`;
    writeFileSync(join(a.out, f), data);
    writeFileSync(join(a.out, `ch.${t.table}.sql`), ddl);
    m.clickhouse.tables.push({ ...t, ddl: `ch.${t.table}.sql`, data: f, dataSha256: sha(data) });
  }
  writeFileSync(join(a.out, "manifest.json"), JSON.stringify(m, null, 2));
  return m;
}

export interface Verification {
  ok: boolean;
  checks: Array<{ what: string; expected: string | number; actual: string | number; ok: boolean }>;
}

/** Recompute counts and hashes on the restored databases and compare them to the manifest. */
export async function verify(a: {
  dir: string;
  pgDb: string;
  chDb: string;
  dst?: Endpoints;
}): Promise<Verification> {
  const e = a.dst ?? ISOLATED_ENDPOINTS;
  const m = JSON.parse(readFileSync(join(a.dir, "manifest.json"), "utf8")) as Manifest;
  const checks: Verification["checks"] = [];
  const add = (what: string, expected: string | number, actual: string | number) =>
    checks.push({ what, expected, actual, ok: expected === actual });
  add("postgres dump sha256", m.postgres.dumpSha256, sha(readFileSync(join(a.dir, m.postgres.dump))));
  const pgNow = new Map((await pgSums(e, a.pgDb)).map((t) => [`${t.schema}.${t.table}`, t]));
  for (const t of m.postgres.tables) {
    const n = pgNow.get(`${t.schema}.${t.table}`);
    add(`pg ${t.schema}.${t.table} rows`, t.rows, n?.rows ?? -1);
    add(`pg ${t.schema}.${t.table} hash`, t.hash, n?.hash ?? "missing");
  }
  const chNow = new Map((await chSums(e, a.chDb)).map((t) => [t.table, t]));
  for (const t of m.clickhouse.tables) {
    add(`ch ${t.table} backup file sha256`, t.dataSha256, sha(readFileSync(join(a.dir, t.data))));
    const n = chNow.get(t.table);
    add(`ch ${t.table} rows`, t.rows, n?.rows ?? -1);
    add(`ch ${t.table} hash`, t.hash, n?.hash ?? "missing");
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export async function restore(a: {
  dir: string;
  pgDb: string;
  chDb: string;
  dst?: Endpoints;
}): Promise<Verification> {
  const e = a.dst ?? ISOLATED_ENDPOINTS;
  guardRestoreTarget(e);
  const m = JSON.parse(readFileSync(join(a.dir, "manifest.json"), "utf8")) as Manifest;
  const dump = readFileSync(join(a.dir, m.postgres.dump));
  if (sha(dump) !== m.postgres.dumpSha256)
    throw new Error("restore refused: postgres dump checksum differs from the manifest");
  psql(e, "postgres", `CREATE DATABASE ${ident(a.pgDb)}`);
  // pg_restore reports non-fatal role/ownership notices on stderr; a nonzero exit is still a failure
  dockerExec(
    e.pgContainer,
    ["pg_restore", "-U", e.pgUser, "-d", ident(a.pgDb), "--no-owner", "--exit-on-error"],
    dump,
  );
  await chRaw(e, `CREATE DATABASE IF NOT EXISTS \`${ident(a.chDb)}\``);
  for (const t of m.clickhouse.tables) {
    const data = readFileSync(join(a.dir, t.data));
    if (sha(data) !== t.dataSha256)
      throw new Error(`restore refused: ${t.data} checksum differs from the manifest`);
    const ddl = readFileSync(join(a.dir, t.ddl), "utf8").replace(
      new RegExp(`^CREATE TABLE \`?${ident(m.clickhouse.database)}\`?\\.`),
      `CREATE TABLE \`${ident(a.chDb)}\`.`,
    );
    await chRaw(e, ddl);
    await chRaw(e, `INSERT INTO \`${ident(a.chDb)}\`.\`${ident(t.table)}\``, {
      body: data,
      format: "Native",
    });
  }
  return verify(a);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const arg = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const need = (n: string) =>
    arg(n) ??
    (() => {
      throw new Error(`--${n} is required`);
    })();
  if (cmd === "backup") {
    const src: Endpoints = {
      ...ISOLATED_ENDPOINTS,
      ...(arg("pg-container") ? { pgContainer: arg("pg-container")! } : {}),
      ...(arg("pg-port") ? { pgPort: Number(arg("pg-port")) } : {}),
      ...(arg("ch-url") ? { chUrl: arg("ch-url")! } : {}),
    };
    const m = await backup({ pgDb: need("pg-db"), chDb: need("ch-db"), out: need("out"), src });
    console.log(JSON.stringify({ pgTables: m.postgres.tables.length, chTables: m.clickhouse.tables.length }));
  } else if (cmd === "restore" || cmd === "verify") {
    const fn = cmd === "restore" ? restore : verify;
    const v = await fn({ dir: need("dir"), pgDb: need("pg-db"), chDb: need("ch-db") });
    console.log(JSON.stringify({ ok: v.ok, failed: v.checks.filter((c) => !c.ok), checks: v.checks.length }));
    process.exit(v.ok ? 0 : 1);
  } else {
    console.error("usage: backup-restore.ts backup|restore|verify ...");
    process.exit(2);
  }
}
if (process.argv[1]?.endsWith("backup-restore.ts") && existsSync(process.argv[1])) await main();

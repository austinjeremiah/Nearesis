/**
 * Backup and restore drill (ch.17, ch.21 "Restore drill"): seeds a real kernel + runtime Postgres database and a
 * ClickHouse database in the ISOLATED chaos stack, backs both up with scripts/chaos/backup-restore.ts, restores into new
 * databases and verifies row counts and content hashes against the manifest. Negative controls: a corrupted dump and a
 * tampered ClickHouse export must be refused, and a restore aimed at a non-isolated endpoint must be refused.
 * Requires `scripts/chaos/stack.sh up`; without it the test records BLOCKED and does not fail.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { ISOLATED_ENDPOINTS, backup, restore, verify } from "../../scripts/chaos/backup-restore.ts";
import { CH_URL, stackHealthy, useIsolatedEnv } from "../perf/_chaos.ts";

useIsolatedEnv();
const sfx = randomBytes(4).toString("hex");
let SRC_PG = "";
const SRC_CH = `drill_src_${sfx}`;
const OUT = mkdtempSync(join(tmpdir(), "nearesis-drill-"));
let healthy = false;
let drop: (() => Promise<void>) | undefined;

const ch = async (sql: string, body?: string) => {
  const u = new URL(CH_URL);
  u.searchParams.set("query", sql);
  const r = await fetch(u, {
    method: "POST",
    headers: { "x-clickhouse-user": "nearesis", "x-clickhouse-key": "nearesis" },
    ...(body ? { body } : {}),
  });
  if (!r.ok) throw new Error(`ch ${r.status} ${(await r.text()).slice(0, 200)}`);
};

beforeAll(async () => {
  healthy = (await stackHealthy()).ok;
  if (!healthy) return;
  const kt = await import("../../packages/kernel/test/helpers/index.ts");
  const wf = await import("../../packages/workflow/src/db.ts");
  // Postgres source: a real kernel database (RLS, functions, migrations) plus the runtime schema.
  const db = await kt.createTestDb();
  SRC_PG = db.name;
  await wf.migrate(wf.makePool(db.adminUrl, 2));
  await kt.seedOrg(db.admin, "drill", { alice: "owner" });
  for (let i = 0; i < 50; i++)
    await db.admin.query(
      "INSERT INTO runtime.ops_alerts (tenant_id, workspace_id, alert_key, kind, status, payload) VALUES (NULL, NULL, $1, 'drill', 'sent', $2)",
      [`k${i}`, JSON.stringify({ i, note: "restore drill" })],
    );
  drop = async () => {
    await db.drop();
    await psqlDrop(`${SRC_PG}_r`);
    for (const c of [SRC_CH, `${SRC_CH}_r`]) await ch(`DROP DATABASE IF EXISTS ${c}`);
  };
  // ClickHouse source
  await ch(`CREATE DATABASE ${SRC_CH}`);
  await ch(
    `CREATE TABLE ${SRC_CH}.events (day Date, wallet String, amount Decimal(38,6), tags Array(String)) ENGINE = MergeTree ORDER BY (day, wallet)`,
  );
  const rows = Array.from({ length: 20000 }, (_, i) =>
    JSON.stringify({
      day: `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
      wallet: `w${i % 977}.near`,
      amount: (i * 1.37).toFixed(6),
      tags: [`t${i % 7}`],
    }),
  ).join("\n");
  await ch(`INSERT INTO ${SRC_CH}.events FORMAT JSONEachRow`, rows);
  await ch(`CREATE TABLE ${SRC_CH}.empty_t (a UInt8) ENGINE = MergeTree ORDER BY a`);
}, 180_000);
afterAll(async () => drop?.());

const psqlDrop = async (db: string) => {
  const { spawnSync } = await import("node:child_process");
  spawnSync("docker", [
    "exec",
    "nearesis-chaos-postgres-1",
    "psql",
    "-U",
    "nearesis",
    "-d",
    "postgres",
    "-c",
    `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`,
  ]);
};

it("backup then restore into new databases verifies every count and hash; tampering is refused", async () => {
  if (!healthy) {
    observe({
      testId: "OPS-RESTORE",
      observed: "not executed",
      blocked: "isolated chaos stack is not running",
    });
    return;
  }
  const t0 = Date.now();
  const m = await backup({ pgDb: SRC_PG, chDb: SRC_CH, out: OUT });
  const backupMs = Date.now() - t0;
  expect(m.postgres.tables.length).toBeGreaterThan(20);
  expect(m.postgres.tables.find((t) => t.table === "ops_alerts")!.rows).toBe(50);
  expect(m.clickhouse.tables.find((t) => t.table === "events")!.rows).toBe(20000);
  expect(m.clickhouse.tables.map((t) => t.table).sort()).toEqual(["empty_t", "events"]);

  const t1 = Date.now();
  const v = await restore({ dir: OUT, pgDb: `${SRC_PG}_r`, chDb: `${SRC_CH}_r` });
  const restoreMs = Date.now() - t1;
  expect(v.checks.filter((c) => !c.ok)).toEqual([]);
  expect(v.ok).toBe(true);
  // an independent re-verification passes again
  expect((await verify({ dir: OUT, pgDb: `${SRC_PG}_r`, chDb: `${SRC_CH}_r` })).ok).toBe(true);

  // negative control 1: a restored database whose data diverged fails verification
  await ch(`INSERT INTO ${SRC_CH}_r.events VALUES ('2026-10-01','intruder.near',1,['x'])`);
  const diverged = await verify({ dir: OUT, pgDb: `${SRC_PG}_r`, chDb: `${SRC_CH}_r` });
  expect(diverged.ok).toBe(false);
  expect(diverged.checks.filter((c) => !c.ok).map((c) => c.what)).toEqual(
    expect.arrayContaining(["ch events rows", "ch events hash"]),
  );
  // negative control 2: a corrupted dump is refused before anything is written
  const dumpPath = join(OUT, "postgres.dump");
  const good = readFileSync(dumpPath);
  const bad = Buffer.from(good);
  bad[Math.floor(bad.length / 2)] ^= 0xff;
  writeFileSync(dumpPath, bad);
  await expect(restore({ dir: OUT, pgDb: `${SRC_PG}_x`, chDb: `${SRC_CH}_x` })).rejects.toThrow(/checksum/);
  writeFileSync(dumpPath, good);
  // negative control 3: a restore aimed outside the isolated stack is refused
  await expect(
    restore({
      dir: OUT,
      pgDb: "nearesis",
      chDb: "nearesis",
      dst: { ...ISOLATED_ENDPOINTS, pgPort: 55432, pgContainer: "nearesis-postgres-1" },
    }),
  ).rejects.toThrow(/isolated/);

  observe({
    testId: "OPS-RESTORE",
    observed: `Postgres ${m.postgres.tables.length} tables and ClickHouse ${m.clickhouse.tables.length} tables backed up in ${backupMs} ms and restored in ${restoreMs} ms; ${v.checks.length} checks (dump and export sha256, row counts, content hashes) all equal to the manifest. Controls: divergent restore detected, corrupted dump refused, non-isolated target refused`,
    fixtureHash: m.postgres.dumpSha256,
    evidence: { checks: v.checks.length, backupMs, restoreMs, tables: m.postgres.tables.length },
  });
}, 300_000);

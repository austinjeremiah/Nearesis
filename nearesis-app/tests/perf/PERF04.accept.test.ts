/**
 * PERF04: backup and restore. PASS: data reconciles and outbox replay is consistent.
 * A populated kernel database (workspaces, commands, canvas, markers, event journal, outbox with a half-delivered
 * backlog and a consumer projection) is dumped with the Postgres container's pg_dump (custom format) and restored into a
 * second disposable database with pg_restore. Reconciliation: per-table row count and content hash, RLS/policy/grant
 * metadata, gap-free event sequences. Replay: draining the restored outbox produces exactly the missing effects once;
 * forcing the whole outbox to be re-published produces none; the final projection equals a never-backed-up control.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { PanelSpec } from "../../packages/contracts/src/index.ts";
import { Db, OutboxPublisher } from "../../packages/kernel/src/index.ts";
import type { Kernel, Session } from "../../packages/kernel/src/index.ts";
import {
  createTestDb,
  createWs,
  loginSession,
  runCmd,
  seedOrg,
  testKernel,
} from "../../packages/kernel/test/helpers/index.ts";
import type { TestDb } from "../../packages/kernel/test/helpers/index.ts";
import { DRYRUN, conditions, gate, reference, sha256Text } from "./_reference.ts";

const WORKSPACES = 40;
export const FIXTURE_SPEC = {
  workspaces: WORKSPACES,
  perWorkspace: { objectiveUpdates: 3, panels: 3, markers: 1 },
  halfDeliveredBeforeBackup: "6 batches of 25 outbox rows",
  dump: "pg_dump -Fc via docker exec nearesis-postgres-1",
  restore: "pg_restore into a fresh database",
};
const PG = "nearesis-postgres-1";

let src: TestDb;
let k: Kernel;
let s: Session;
const g = gate(import.meta.url);
beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  src = await createTestDb();
  k = testKernel(src);
  s = await loginSession(k, (await seedOrg(src.admin, "perf04", { alice: "owner" })).users.alice!.subject);
}, 120_000);
let restoredName = "";
afterAll(async () => {
  if (restoredName)
    await src?.admin.query(`DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`).catch(() => undefined);
  await src?.drop();
});

const sh = (...args: string[]) => {
  const r = spawnSync("docker", ["exec", "-e", "PGPASSWORD=nearesis", PG, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.slice(-600) };
};
const panel = (n: number) =>
  PanelSpec.parse({
    panelId: randomUUID(),
    schemaVersion: 1,
    kind: "timeSeries",
    title: `Panel ${n}`,
    queryRef: { hash: "c".repeat(64), semanticVersion: "1.0.0", snapshotPolicy: "live" },
    dataBinding: { fields: ["day", "v"], units: { v: "count" }, timezone: "UTC", completeness: "complete" },
    encoding: { x: "day", y: ["v"] },
    layout: { x: (n % 2) * 6, y: Math.floor(n / 2) * 4, w: 6, h: 4 },
    refreshPolicy: { mode: "manual" },
    provenanceRequired: true,
  });

it("PERF04: a pg_dump/pg_restore round trip reconciles and the restored outbox replays consistently", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF04", observed: "not executed", blocked: g.reason });
    return;
  }
  const th = reference().thresholds.PERF04!;
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF04 ${fixtureHash}\n`);
  if (g.ok) expect(reference().fixtures.PERF04).toBe(fixtureHash);

  // ---- populate through the real command bus
  await src.admin.query(
    "CREATE TABLE perf04_projection(event_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, seq integer NOT NULL, event_type text NOT NULL)",
  );
  await src.admin.query("GRANT SELECT, INSERT ON perf04_projection TO nearesis_app");
  const ver = async (ws: string) => (await k.workspaces.get(s, ws)).version;
  for (let w = 0; w < WORKSPACES; w++) {
    const { workspaceId } = await createWs(k, s, `perf04 ${w}`);
    for (let i = 0; i < 3; i++)
      await runCmd(
        k,
        s,
        workspaceId,
        "workspace.update_objective",
        { objective: `objective ${w}.${i}` },
        await ver(workspaceId),
      );
    const panels = [panel(0), panel(1), panel(2)];
    await runCmd(
      k,
      s,
      workspaceId,
      "canvas.apply_patch",
      {
        schemaVersion: 1,
        type: "workspace.patch",
        operationId: randomUUID(),
        expectedRevision: 0,
        operations: panels.map((p) => ({ op: "addPanel", panel: p })),
      },
      await ver(workspaceId),
    );
    await runCmd(
      k,
      s,
      workspaceId,
      "marker.create",
      {
        panelId: panels[0]!.panelId,
        markerId: randomUUID(),
        anchor: { kind: "time_point", at: "2026-10-28T00:00:00.000Z" },
        question: "why",
      },
      await ver(workspaceId),
    );
  }

  // consumer: one projection row per event, written in the same transaction as its receipt
  const makePublisher = (db: Db, counter: { n: number }) => {
    const p = new OutboxPublisher(db);
    p.register("projector", async ({ tx, event }) => {
      counter.n++;
      await tx.query(
        "INSERT INTO perf04_projection(event_id, workspace_id, seq, event_type) VALUES ($1,$2,$3,$4)",
        [event.eventId, event.workspaceId, event.seq, event.type],
      );
    });
    return p;
  };
  const beforeCounter = { n: 0 };
  const pub0 = makePublisher(src.app, beforeCounter);
  for (let b = 0; b < 6; b++) await pub0.runOnce(25);
  const q = async (admin: TestDb["admin"], text: string) =>
    (await admin.query(text)).rows as Array<Record<string, unknown>>;
  const events = Number((await q(src.admin, "SELECT count(*) n FROM workspace_events"))[0]!.n);
  const pendingAtBackup = Number(
    (await q(src.admin, "SELECT count(*) n FROM outbox WHERE published_at IS NULL"))[0]!.n,
  );
  const deliveredAtBackup = Number((await q(src.admin, "SELECT count(*) n FROM perf04_projection"))[0]!.n);
  expect(pendingAtBackup).toBeGreaterThan(0);
  expect(deliveredAtBackup).toBeGreaterThan(0);
  expect(deliveredAtBackup + pendingAtBackup).toBe(events);

  // ---- backup
  const dumpFile = `/tmp/perf04-${randomBytes(4).toString("hex")}.dump`;
  const t0 = Date.now();
  const dump = sh("pg_dump", "-U", "nearesis", "-d", src.name, "-Fc", "-f", dumpFile);
  const dumpMs = Date.now() - t0;
  expect(dump.status, dump.out).toBe(0);
  const size = Number(sh("stat", "-c", "%s", dumpFile).out.trim());

  // ---- restore into a fresh database
  restoredName = `nearesis_t_perf4r_${randomBytes(4).toString("hex")}`;
  await src.admin.query(`CREATE DATABASE ${restoredName}`);
  const t1 = Date.now();
  const restore = sh("pg_restore", "-U", "nearesis", "-d", restoredName, "--exit-on-error", dumpFile);
  const restoreMs = Date.now() - t1;
  sh("rm", "-f", dumpFile);
  expect(restore.status, restore.out).toBe(0);
  const u = new URL(src.appUrl);
  u.pathname = `/${restoredName}`;
  const dst = Db.connect(u.toString(), 4);
  const au = new URL(src.adminUrl);
  au.pathname = `/${restoredName}`;
  const Pool = src.admin.constructor as new (o: { connectionString: string; max: number }) => TestDb["admin"];
  const dstAdmin = new Pool({ connectionString: au.toString(), max: 2 });
  dstAdmin.on("error", () => undefined);
  try {
    // ---- reconcile: counts and content per table
    const tables = (
      await q(src.admin, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")
    ).map((r) => String(r.tablename));
    const digest = async (admin: TestDb["admin"], t: string) =>
      (
        await q(
          admin,
          `SELECT count(*)::text n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM public."${t}" x`,
        )
      )[0]!;
    let countMismatch = 0;
    let hashMismatch = 0;
    let rows = 0;
    const perTable: Record<string, { rows: number }> = {};
    for (const t of tables) {
      const a = await digest(src.admin, t);
      const b = await digest(dstAdmin, t);
      if (a.n !== b.n) countMismatch++;
      if (a.h !== b.h) hashMismatch++;
      rows += Number(a.n);
      perTable[t] = { rows: Number(a.n) };
    }
    const meta = async (admin: TestDb["admin"]) =>
      JSON.stringify(
        await q(
          admin,
          `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
                  (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
                  (SELECT count(*) FROM information_schema.role_table_grants g WHERE g.table_name = c.relname AND g.grantee = 'nearesis_app') AS app_grants
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1`,
        ),
      );
    const metaEqual = (await meta(src.admin)) === (await meta(dstAdmin));
    const seqGaps = Number(
      (
        await q(
          dstAdmin,
          "SELECT count(*) n FROM (SELECT workspace_id FROM workspace_events GROUP BY 1 HAVING max(seq) <> count(*) OR min(seq) <> 1) x",
        )
      )[0]!.n,
    );
    expect(countMismatch).toBe(th.maxTableCountMismatches);
    expect(hashMismatch).toBe(th.maxTableHashMismatches);
    expect(metaEqual).toBe(true);
    expect(seqGaps).toBe(th.maxSeqGaps);
    // the restored database still isolates tenants (RLS survived): no context sees nothing, the org sees its own rows
    const noCtx = Number(
      ((await dst.pool.query("SELECT count(*)::int n FROM workspaces")).rows[0] as { n: number }).n,
    );
    expect(noCtx).toBe(0);

    // ---- outbox replay on the restored database
    const restoredPending = Number(
      (await q(dstAdmin, "SELECT count(*) n FROM outbox WHERE published_at IS NULL"))[0]!.n,
    );
    expect(restoredPending).toBe(pendingAtBackup);
    const replay1 = { n: 0 };
    const pubR = makePublisher(dst, replay1);
    for (let i = 0; i < 200; i++) if ((await pubR.runOnce(100)).delivered === 0) break;
    const projHash = async (admin: TestDb["admin"]) =>
      (
        await q(
          admin,
          "SELECT count(*)::text n, md5(string_agg(event_id::text || ':' || seq::text || ':' || event_type, '|' ORDER BY workspace_id, seq)) h FROM perf04_projection",
        )
      )[0]!;
    const afterDrain = await projHash(dstAdmin);
    const stillPending = Number(
      (await q(dstAdmin, "SELECT count(*) n FROM outbox WHERE published_at IS NULL"))[0]!.n,
    );
    expect(stillPending).toBe(0);
    expect(Number(afterDrain.n)).toBe(events);
    expect(replay1.n).toBe(pendingAtBackup); // exactly the missing effects, once each
    // forced full replay: every outbox row published again; receipts dedupe, so no effect runs
    await dstAdmin.query("UPDATE outbox SET published_at = NULL, attempts = 0");
    const replay2 = { n: 0 };
    const pubR2 = makePublisher(dst, replay2);
    for (let i = 0; i < 200; i++) if ((await pubR2.runOnce(100)).delivered === 0) break;
    const afterReplay = await projHash(dstAdmin);
    const receipts = Number(
      (await q(dstAdmin, "SELECT count(*) n FROM consumer_receipts WHERE consumer='projector'"))[0]!.n,
    );
    const duplicateEffects = replay2.n + (replay1.n - pendingAtBackup);
    expect(replay2.n).toBe(0);
    expect(afterReplay).toEqual(afterDrain);
    expect(receipts).toBe(events);
    expect(duplicateEffects).toBe(th.maxDuplicateEffects);
    // control: the never-backed-up source drained the same way yields the identical projection
    const ctl = { n: 0 };
    const pubC = makePublisher(src.app, ctl);
    for (let i = 0; i < 200; i++) if ((await pubC.runOnce(100)).delivered === 0) break;
    const control = await projHash(src.admin);
    expect(control).toEqual(afterDrain);
    if (DRYRUN) return;

    observe({
      testId: "PERF04",
      observed: `${tables.length} tables / ${rows} rows (${events} journal events, ${pendingAtBackup} outbox rows pending and ${deliveredAtBackup} delivered at backup) dumped in ${dumpMs} ms (${size} bytes) and restored in ${restoreMs} ms; per-table count mismatches ${countMismatch}, content-hash mismatches ${hashMismatch}, RLS/policy/grant metadata identical ${metaEqual}, event sequence gaps ${seqGaps}, tenant isolation intact after restore; draining the restored outbox ran exactly ${replay1.n} missing effects once; a forced full re-publish of ${events} outbox rows ran ${replay2.n} effects (receipts ${receipts}); final projection equals the never-backed-up control (${afterDrain.h})`,
      fixtureHash,
      evidence: {
        environment: "reference",
        profile: g.ok ? g.fingerprint : null,
        referenceSha256: g.ok ? g.referenceSha256 : null,
        adrSha256: g.ok ? g.adrSha256 : null,
        conditions: conditions(),
        dataset: { id: "perf04 fixture spec", sha256: fixtureHash, tables: tables.length, rows, events },
        concurrency: "sequential (one dump, one restore, single publisher)",
        cacheState: "n/a",
        timingsMs: { dump: dumpMs, restore: restoreMs },
        dumpBytes: size,
        counts: {
          countMismatch,
          hashMismatch,
          seqGaps,
          pendingAtBackup,
          deliveredAtBackup,
          replayEffects: replay1.n,
          forcedReplayEffects: replay2.n,
          receipts,
          controlEffects: ctl.n,
        },
      },
    });
  } finally {
    await dst.close();
    await dstAdmin.end();
  }
}, 900_000);

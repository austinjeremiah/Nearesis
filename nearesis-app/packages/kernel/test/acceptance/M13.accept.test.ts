import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { createTestDb, loginSession, seedOrg, testKernel } from "../helpers/index.ts";
import type { TestDb } from "../helpers/index.ts";
import type { Kernel, Session } from "../../src/index.ts";
import { cmd, pollUntil, sha256, shuffled, workspaceWithPanel } from "./m-helpers.ts";

const LEASE_TTL_MS = 3000;
const FAILOVER_BOUND_MS = LEASE_TTL_MS + 5000; // accepted 2026-11-11: lease TTL plus 5 seconds
const WATERMARKS = 60;
const RULES = 5;
const WORKER = fileURLToPath(new URL("./m13-worker.ts", import.meta.url));
const KERNEL_DIR = fileURLToPath(new URL("../..", import.meta.url));

let db: TestDb;
let k: Kernel;
let s: Session;
beforeAll(async () => {
  db = await createTestDb();
  k = testKernel(db);
  s = await loginSession(k, (await seedOrg(db.admin, "m13", { alice: "owner" })).users.alice!.subject);
});
afterAll(async () => db?.drop());

function spawnWorker(appUrl: string, id: string, eventsFile: string, slot: number): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--import", "tsx", WORKER], {
    cwd: KERNEL_DIR,
    env: {
      ...process.env,
      DATABASE_APP_URL: appUrl,
      WORKER_ID: id,
      LEASE_MS: String(LEASE_TTL_MS),
      EVENTS_FILE: eventsFile,
      SLOT: String(slot),
      EMIT_GAP_MS: "40",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`worker ${id} not ready: ${out.slice(-400)}`)), 60_000);
    proc.stdout!.on("data", (b) => {
      out += String(b);
      if (out.includes("READY")) {
        clearTimeout(t);
        resolve(proc);
      }
    });
    proc.stderr!.on("data", (b) => (out += String(b)));
    proc.on("exit", (c) => {
      if (!out.includes("READY")) reject(new Error(`worker ${id} exited ${c}: ${out.slice(-400)}`));
    });
  });
}

const DUP_SQL = `
  SELECT count(*)::int n FROM (
    SELECT rule_id, watermark, rule_version, mode FROM monitor_evaluations
     GROUP BY 1,2,3,4 HAVING count(*) > 1) d`;

it("M13: three competing OS-process scheduler workers evaluate each (rule, watermark, rule version) exactly once and fail over within lease TTL + 5 s after the holder is SIGKILLed", async () => {
  const { workspaceId, panelId } = await workspaceWithPanel(k, db, s);
  const sourceId = `m13.stream.${randomUUID().slice(0, 8)}`;
  const ruleIds: string[] = [];
  for (let i = 0; i < RULES; i++) {
    const markerId = randomUUID();
    await cmd(k, db, s, workspaceId, "marker.create", {
      panelId,
      markerId,
      anchor: { kind: "time_point", at: "2026-10-01T00:00:00Z" },
    });
    const ruleId = randomUUID();
    ruleIds.push(ruleId);
    await cmd(k, db, s, workspaceId, "monitor.rule_create", {
      ruleId,
      name: `m13 rule ${i}`,
      markerId,
      sourceId,
      action: "investigate",
      condition: { kind: "compare", metricId: "vol", op: "gt", value: 0 }, // true for every watermark
    });
  }
  // fx.monitor.watermark-stream (SYNTHETIC): 60 distinct watermarks, each emitted 3 times, shuffled per worker
  const stream = Array.from({ length: WATERMARKS }, (_, i) => ({
    sourceId,
    watermark: new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString(),
    mode: "live" as const,
    values: { vol: 100 + i },
  }));
  const dir = mkdtempSync(join(tmpdir(), "m13-"));
  const files = [1, 2, 3].map((seed) => {
    const f = join(dir, `events-${seed}.json`);
    writeFileSync(f, JSON.stringify(shuffled(stream, seed)));
    return f;
  });

  const workers: Array<{ id: string; proc: ChildProcess }> = [];
  for (let i = 0; i < 3; i++)
    workers.push({ id: `w${i}`, proc: await spawnWorker(db.appUrl, `w${i}`, files[i]!, i) });
  const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await db.admin.query(text, params)).rows as T[];
  const evalCount = async () =>
    (await q<{ n: number }>("SELECT count(*)::int n FROM monitor_evaluations"))[0]!.n;

  let killed: { holder: string; fence: number; at: Date } | undefined;
  try {
    // midway: SIGKILL the lease holder
    await pollUntil(async () => (await evalCount()) >= 100, 60_000, 50, "100 evaluations");
    const lease = (
      await q<{ holder: string; fence: string }>("SELECT holder, fence FROM monitor_scheduler_lease")
    )[0]!;
    const victim = workers.find((w) => w.id === lease.holder)!;
    const killAt = (await q<{ t: Date }>("SELECT clock_timestamp() t"))[0]!.t;
    victim.proc.kill("SIGKILL");
    killed = { holder: lease.holder, fence: Number(lease.fence), at: killAt };
    const midway = await evalCount();
    expect(midway).toBeLessThan(RULES * WATERMARKS); // the stream was genuinely unfinished at the kill

    await pollUntil(
      async () => (await evalCount()) >= RULES * WATERMARKS,
      90_000,
      100,
      "all 300 evaluations",
    );
  } finally {
    for (const w of workers)
      if (w.proc.exitCode === null && w.proc.signalCode === null) w.proc.kill("SIGTERM");
    await Promise.all(
      workers.map(
        (w) =>
          new Promise<void>((r) => {
            if (w.proc.exitCode !== null || w.proc.signalCode !== null) return r();
            const t = setTimeout(() => (w.proc.kill("SIGKILL"), r()), 8000);
            w.proc.on("exit", () => (clearTimeout(t), r()));
          }),
      ),
    );
  }

  // (a) exactly 60 x 5 evaluation rows, unique on the key; 300 triggers; no duplicate trigger or task
  const evals = await q<{ n: number; distinct: number }>(
    "SELECT count(*)::int n, count(DISTINCT (rule_id, watermark, rule_version, mode))::int distinct FROM monitor_evaluations",
  );
  expect(evals[0]).toEqual({ n: 300, distinct: 300 });
  expect((await q<{ n: number }>(DUP_SQL))[0]!.n).toBe(0);
  const trig = await q<{ n: number; fired: number; distinct: number }>(
    "SELECT count(*)::int n, count(*) FILTER (WHERE outcome='fired')::int fired, count(DISTINCT (rule_id, watermark, mode))::int distinct FROM monitor_triggers",
  );
  expect(trig[0]).toEqual({ n: 300, fired: 300, distinct: 300 });
  const tasks = await q<{ n: number; distinct: number }>(
    "SELECT count(*)::int n, count(DISTINCT trigger_id)::int distinct FROM marker_tasks",
  );
  expect(tasks[0]).toEqual({ n: 300, distinct: 300 });
  const perRule = await q<{ c: number }>("SELECT count(*)::int c FROM monitor_evaluations GROUP BY rule_id");
  expect(perRule.map((r) => r.c)).toEqual(Array(RULES).fill(WATERMARKS));
  const lost = await q<{ n: number }>(
    `SELECT count(*)::int n FROM (SELECT DISTINCT watermark FROM monitor_evaluations) e`,
  );
  expect(lost[0]!.n).toBe(WATERMARKS); // no watermark lost

  // (b) lease history never overlaps
  const hist = await q<{ fence: string; holder: string; acquired_at: Date; expires_at: Date }>(
    "SELECT fence, holder, acquired_at, expires_at FROM monitor_scheduler_lease_history ORDER BY fence",
  );
  expect(hist.length).toBeGreaterThanOrEqual(2);
  const overlaps: Array<{ a: string; b: string; ms: number }> = [];
  for (let i = 1; i < hist.length; i++) {
    const gap = hist[i]!.acquired_at.getTime() - hist[i - 1]!.expires_at.getTime();
    if (gap < 0) overlaps.push({ a: hist[i - 1]!.holder, b: hist[i]!.holder, ms: gap });
  }
  expect(overlaps).toEqual([]);

  // (c) failover bound
  const next = hist.find((h) => Number(h.fence) > killed!.fence)!;
  expect(next.holder).not.toBe(killed!.holder);
  const failoverMs = next.acquired_at.getTime() - killed!.at.getTime();
  expect(failoverMs).toBeLessThanOrEqual(FAILOVER_BOUND_MS);

  // (d) a forced duplicate insert, bypassing every application path, is rejected by the database constraint
  const sample = (
    await q<{
      id: string;
      rule_id: string;
      org_id: string;
      workspace_id: string;
      watermark: Date;
      rule_version: number;
      source_id: string;
    }>("SELECT * FROM monitor_evaluations LIMIT 1")
  )[0]!;
  const forced = await db.admin
    .query(
      `INSERT INTO monitor_evaluations(id, org_id, workspace_id, rule_id, rule_version, source_id, watermark, mode, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'live','fired')`,
      [
        randomUUID(),
        sample.org_id,
        sample.workspace_id,
        sample.rule_id,
        sample.rule_version,
        sample.source_id,
        sample.watermark,
      ],
    )
    .then(
      () => "inserted",
      (e: { code?: string }) => e.code ?? "error",
    );
  expect(forced).toBe("23505");
  const forcedTrigger = await db.admin
    .query(
      `INSERT INTO monitor_triggers(id, org_id, workspace_id, rule_id, source_id, watermark, mode, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,'live','fired')`,
      [randomUUID(), sample.org_id, sample.workspace_id, sample.rule_id, sample.source_id, sample.watermark],
    )
    .then(
      () => "inserted",
      (e: { code?: string }) => e.code ?? "error",
    );
  expect(forcedTrigger).toBe("23505");

  // Negative control (separate disposable database): the unique constraints are dropped and nothing coordinates three
  // concurrent writers (no lease, no row lock). The detector must then report duplicates, proving the test can see them.
  const ctl = await createTestDb();
  let controlDuplicates!: number;
  try {
    const ck = testKernel(ctl);
    const cs = await loginSession(
      ck,
      (await seedOrg(ctl.admin, "m13c", { alice: "owner" })).users.alice!.subject,
    );
    const cw = await workspaceWithPanel(ck, ctl, cs);
    const rid = randomUUID();
    await cmd(ck, ctl, cs, cw.workspaceId, "monitor.rule_create", {
      ruleId: rid,
      name: "control",
      sourceId: "m13.control",
      condition: { kind: "compare", metricId: "vol", op: "gt", value: 0 },
    });
    await ctl.admin.query(
      "ALTER TABLE monitor_evaluations DROP CONSTRAINT monitor_evaluations_rule_id_watermark_rule_version_mode_key",
    );
    const org = (await ctl.admin.query("SELECT org_id FROM workspaces WHERE id=$1", [cw.workspaceId])).rows[0]
      .org_id;
    await Promise.all(
      [0, 1, 2].map(async () => {
        for (let i = 0; i < 10; i++)
          await ctl.admin.query(
            `INSERT INTO monitor_evaluations(id, org_id, workspace_id, rule_id, rule_version, source_id, watermark, mode, status)
             VALUES ($1,$2,$3,$4,1,'m13.control',$5,'live','fired')`,
            [randomUUID(), org, cw.workspaceId, rid, new Date(Date.UTC(2026, 9, 28, 0, i)).toISOString()],
          );
      }),
    );
    controlDuplicates = (await ctl.admin.query(DUP_SQL)).rows[0].n as number;
    expect(controlDuplicates).toBe(10); // the detector sees every duplicated key
  } finally {
    await ctl.drop();
  }

  observe({
    testId: "M13",
    observed: `3 OS-process scheduler workers (each emitting the shuffled 60-watermark stream, 3 emissions per watermark, plus direct racing evaluations) over ${RULES} rules: ${evals[0]!.n} evaluation rows unique on (rule, watermark, rule version, mode), ${trig[0]!.fired} fired triggers, ${tasks[0]!.n} tasks (0 duplicates, 0 lost watermarks). Lease holder ${killed!.holder} was SIGKILLed with ${evals[0] ? "the stream unfinished" : ""}; ${next.holder} acquired the lease ${failoverMs} ms later (bound ${FAILOVER_BOUND_MS} ms = TTL ${LEASE_TTL_MS} + 5000) and finished the stream. Lease history (${hist.length} holders) shows 0 overlaps. Forced duplicate INSERTs bypassing the application were rejected with SQLSTATE ${forced}/${forcedTrigger}. Negative control (constraints dropped, 3 uncoordinated writers): the detector reported ${controlDuplicates} duplicated keys`,
    fixtureHash: sha256({
      fixture: "fx.monitor.watermark-stream",
      sourceId: "m13.stream",
      stream,
      seeds: [1, 2, 3],
    }),
    evidence: {
      evaluations: evals[0],
      triggers: trig[0],
      tasks: tasks[0],
      killed: { holder: killed!.holder, fence: killed!.fence },
      failoverMs,
      failoverBoundMs: FAILOVER_BOUND_MS,
      leaseHistory: hist.map((h) => ({
        fence: h.fence,
        holder: h.holder,
        acquired: h.acquired_at.toISOString(),
        expires: h.expires_at.toISOString(),
      })),
      overlaps,
      forcedDuplicateSqlstate: { evaluations: forced, triggers: forcedTrigger },
      control: controlDuplicates,
    },
  });
}, 180_000);

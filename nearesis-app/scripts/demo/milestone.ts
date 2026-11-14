/**
 * `pnpm demo:milestone` - the directive's 18-step integrated demonstration (starting_prompt.md section 18).
 *
 * Every step is recorded with status (PASS / FAIL / BLOCKED), mode (fixture-backed / live), timing and evidence.
 * A step whose dependency is not delivered yet is BLOCKED with the owner; no step is ever simulated.
 * Output: NEARESIS_Build_Bible/reports/RELEASES/MILESTONE-<runId>/{steps.json,logs,screenshots} and the release
 * report MILESTONE-P00-P05-<runId>.md. One coordination event per step via `pnpm coord event`.
 *
 * Flags: --no-web (skip starting the web app), --keep (leave API/web running)
 */
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
  APP_ROOT,
  BIBLE,
  Recorder,
  api,
  gitHead,
  httpOk,
  portBusy,
  loadEnv,
  requireFrom,
  spawnLogged,
  waitFor,
  type Child,
} from "./common.ts";
import { migrate as migrateRuntime, makePool } from "../../packages/workflow/src/db.ts";
import { setupCheckpointer } from "../../packages/agent-runtime/src/checkpointer.ts";
import { writeReport } from "./report.ts";
import { agentSteps, startWorker } from "./agent-steps.ts";
import {
  CUBE_URL_DEFAULT,
  acquireDataLock,
  createCh,
  cubeReady,
  defaultCubeSecret,
  loadNormalized,
  loadRegistry,
  queryRows,
  resetData,
  settleRollups,
  signCubeToken,
} from "../../services/analytics/src/index.ts";
import { replayDetailed } from "../../services/ingestion/src/replay.ts";
import { DEFAULT_POLICY, createGateway } from "../../packages/semantic-gateway/src/index.ts";

loadEnv();
const flags = new Set(process.argv.slice(2));
const API_PORT = 4810;
const WEB_PORT = 3800;
const API = `http://127.0.0.1:${API_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
const CUBE = process.env.NEARESIS_CUBE_URL ?? CUBE_URL_DEFAULT;
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://nearesis:nearesis@127.0.0.1:55432/nearesis";
const SNAPSHOT = "fx.snapshot.p02-baseline";

const runId = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
const nonce = randomBytes(3).toString("hex");
const TASK_QUEUE = `demo-milestone-${nonce}`;
const rec = new Recorder(runId);
const children: Child[] = [];
let release: (() => Promise<void>) | undefined;
let webUp = false;
const worker: { child: Child | null; taskQueue: string } = { child: null, taskQueue: TASK_QUEUE };

interface PgPool {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
  end(): Promise<void>;
}
const pg = requireFrom<{ Pool: new (o: { connectionString: string; max: number }) => PgPool }>(
  "services/analytics",
  "pg",
);
const { Redis } = requireFrom<{ Redis: new (url: string, o: object) => RedisLike }>(
  "services/analytics",
  "ioredis",
);

type RedisLike = import("../../packages/semantic-gateway/src/index.ts").RedisLike & { disconnect(): void };

const tcpOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 2000).unref();
  });

// Shared across steps. Separate org / workspace per run (never reuses another run's data).
const ctx: {
  orgId?: string;
  userId?: string;
  subject?: string;
  token?: string;
  workspaceId?: string;
  workspaceVersion?: number;
  runIdAgent?: string;
  queryHash?: string;
} = {};

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  console.log(`Nearesis milestone demo ${runId} (commit ${gitHead()})`);
  rec.coord("heartbeat", "demo.milestone", `run ${runId} started`);

  // 1 ------------------------------------------------------------------------------------------------------------
  await rec.step(
    1,
    "Start local environment (compose base + analytics overlay, API :4810, web :3800, worker)",
    "live",
    async () => {
      const ports: Record<string, number> = {
        postgres: 55432,
        redis: 56379,
        clickhouse: 58123,
        temporal: 57233,
      };
      const up: Record<string, boolean> = {};
      for (const [k, p] of Object.entries(ports)) up[k] = await tcpOpen(p);
      up.cube = await cubeReady(CUBE).catch(() => false);
      const down = Object.entries(up)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (down.length)
        return {
          status: "FAIL",
          detail: `infrastructure down: ${down.join(", ")} (run pnpm dev:infra)`,
          facts: { up },
        };

      // Runtime schema (owner: workflow/runtime). Idempotent, uses the owners' own migrators; never touches other schemas.
      const adminPool = makePool(ADMIN_URL, 2);
      let runtimeMigrations: string[];
      try {
        runtimeMigrations = await migrateRuntime(adminPool);
      } finally {
        await adminPool.end();
      }
      await setupCheckpointer(ADMIN_URL);
      // The demo runs its own API, web and worker on its own ports and a unique Temporal task queue; it never touches
      // another agent's or the owner's running stack.
      for (const [label, port] of [
        ["API", API_PORT],
        ["web", WEB_PORT],
      ] as const)
        if (await portBusy(port))
          return { status: "FAIL", detail: `demo ${label} port ${port} is already in use` };
      children.push(
        spawnLogged(rec, "api", "pnpm", ["exec", "tsx", "apps/api/src/main.ts"], {
          env: {
            NODE_ENV: "development",
            DATABASE_URL: ADMIN_URL,
            PORT: String(API_PORT),
            TASK_QUEUE: TASK_QUEUE,
          },
        }),
      );
      await waitFor("API /health", () => httpOk(`${API}/health`), 60_000);
      const apiMode = `started by demo on :${API_PORT} (task queue ${TASK_QUEUE})`;
      let webMode = "skipped (--no-web)";
      webUp = false;
      if (!flags.has("--no-web")) {
        const web = spawnLogged(
          rec,
          "web",
          "pnpm",
          ["exec", "next", "dev", "-p", String(WEB_PORT), "-H", "127.0.0.1"],
          {
            cwd: join(APP_ROOT, "apps", "web"),
            env: { NEARESIS_API_URL: API, NEARESIS_TEST_HOOKS: "1" },
          },
        );
        children.push(web);
        await waitFor(
          "web app",
          async () => web.proc.exitCode !== null || httpOk(`${WEB}/`),
          180_000,
          1000,
        ).catch(() => undefined);
        if (web.proc.exitCode === null && (await httpOk(`${WEB}/`).catch(() => false))) {
          webMode = `started by demo (next dev) on :${WEB_PORT}`;
          webUp = true;
        } else webMode = "next dev did not become ready (see logs/web.log); web steps 10 and 12 are BLOCKED";
      }
      worker.child = startWorker(rec, "worker", TASK_QUEUE);
      let workerMode = `started production worker (pnpm --filter @nearesis/workflow worker) on queue ${TASK_QUEUE}`;
      try {
        await waitFor(
          "worker READY",
          async () => /READY/.test(readFileSync(worker.child!.log, "utf8")),
          90_000,
          500,
        );
      } catch {
        workerMode += "; READY line not seen (see logs/worker.log)";
      }
      return {
        status: "PASS",
        detail: `infra up (${Object.keys(up).join(", ")}); API ${apiMode}; web ${webMode}. Workers: ${workerMode}`,
        evidence: ["logs/api.log", "logs/web.log"].filter((f) => existsSync(join(rec.dir, f))),
        facts: { up, apiMode, webMode, runtimeMigrationsApplied: runtimeMigrations },
      };
    },
  );

  // 2 ------------------------------------------------------------------------------------------------------------
  await rec.step(2, "Authenticate a test user (dev login)", "live", async () => {
    const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    try {
      ctx.orgId = randomUUID();
      ctx.userId = randomUUID();
      ctx.subject = `demo.milestone.${nonce}`;
      await admin.query("INSERT INTO organizations(id, name) VALUES ($1,$2)", [
        ctx.orgId,
        `demo-milestone-${nonce}`,
      ]);
      await admin.query("INSERT INTO users(id, oidc_subject, display_name) VALUES ($1,$2,$3)", [
        ctx.userId,
        ctx.subject,
        "Milestone Demo",
      ]);
      await admin.query("INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'owner')", [
        ctx.orgId,
        ctx.userId,
      ]);
    } finally {
      await admin.end();
    }
    const bad = await api(API, "POST", "/v1/dev/login", { body: { oidcSubject: `nobody.${nonce}` } });
    const r = await api<{ token: string }>(API, "POST", "/v1/dev/login", {
      body: { oidcSubject: ctx.subject },
    });
    if (r.status !== 200 || !r.body?.token)
      return { status: "FAIL", detail: `dev login returned ${r.status}` };
    ctx.token = r.body.token;
    const unauth = await api(API, "POST", "/v1/workspaces", { body: {} });
    const ok = bad.status === 401 && unauth.status === 401;
    return {
      status: ok ? "PASS" : "FAIL",
      detail: `fresh org ${ctx.orgId} / user ${ctx.userId}; token issued (not recorded); unknown subject -> ${bad.status}, unauthenticated call -> ${unauth.status}`,
      facts: {
        orgId: ctx.orgId,
        userId: ctx.userId,
        unknownSubjectStatus: bad.status,
        unauthenticatedStatus: unauth.status,
      },
    };
  });

  // 3 ------------------------------------------------------------------------------------------------------------
  await rec.step(3, "Create a research workspace (POST /v1/workspaces)", "live", async () => {
    if (!ctx.token) return { status: "BLOCKED", detail: "no session from step 2", owner: "A11" };
    const body = {
      objective:
        "Milestone demo: how do NEAR Intents swap volume and route quote availability behave across the baseline window?",
      networkScope: "fixture-only",
      idempotencyKey: `demo-milestone-${runId}`,
    };
    const r = await api<{ workspaceId: string; version: number }>(API, "POST", "/v1/workspaces", {
      token: ctx.token,
      body,
    });
    if (r.status !== 201)
      return { status: "FAIL", detail: `status ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}` };
    ctx.workspaceId = r.body.workspaceId;
    ctx.workspaceVersion = r.body.version;
    const replay = await api<{ workspaceId: string }>(API, "POST", "/v1/workspaces", {
      token: ctx.token,
      body,
    });
    const got = await api<{ id: string; version: number }>(API, "GET", `/v1/workspaces/${ctx.workspaceId}`, {
      token: ctx.token,
    });
    const idem = replay.body?.workspaceId === ctx.workspaceId;
    // The research plugin must be enabled in the workspace for agent runs (same command the dev seed issues).
    const enable = await api(API, "POST", `/v1/workspaces/${ctx.workspaceId}/commands`, {
      token: ctx.token,
      headers: { "if-match": String(ctx.workspaceVersion) },
      body: {
        apiVersion: "v1",
        commandId: randomUUID(),
        commandType: "plugin.enable",
        payload: { pluginId: "near-thesis" },
        expectedVersion: ctx.workspaceVersion,
      },
    });
    const enabled = enable.status >= 200 && enable.status < 300;
    return {
      status: got.status === 200 && idem && enabled ? "PASS" : "FAIL",
      detail: `workspace ${ctx.workspaceId} at version ${ctx.workspaceVersion}; idempotent replay returns the same id: ${idem}; GET ${got.status}; near-thesis plugin.enable -> ${enable.status}${enabled ? "" : " " + JSON.stringify(enable.body).slice(0, 200)}`,
      facts: { workspaceId: ctx.workspaceId, version: ctx.workspaceVersion, idempotentReplay: idem },
    };
  });

  // 4 ------------------------------------------------------------------------------------------------------------
  let replayOut: Awaited<ReturnType<typeof replayDetailed>> | undefined;
  await rec.step(
    4,
    `Load validated NEAR fixture observations (${SNAPSHOT} via the ingestion replay)`,
    "fixture-backed",
    async () => {
      replayOut = await replayDetailed(SNAPSHOT);
      const cli = spawnSync("pnpm", ["exec", "tsx", "src/cli/replay.ts", "--snapshot", SNAPSHOT], {
        cwd: join(APP_ROOT, "services", "ingestion"),
        encoding: "utf8",
      });
      const file = join(rec.logs, "step04-ingestion-replay-cli.json");
      (await import("node:fs")).writeFileSync(file, cli.stdout);
      let summary: Record<string, unknown> = {};
      try {
        summary = JSON.parse(cli.stdout.trim().split("\n").pop() ?? "{}");
      } catch {
        /* reported below */
      }
      const ok =
        cli.status === 0 &&
        replayOut.digestMatches === true &&
        summary.unlabelledRows === 0 &&
        replayOut.credentialReads === 0;
      return {
        status: ok ? "PASS" : "FAIL",
        detail: `snapshot ${SNAPSHOT}: digest ${replayOut.output.digest.slice(0, 16)}... matches sealed digest: ${replayOut.digestMatches}; ${summary.labelledRows} rows all labelled SYNTHETIC/RECORDED, ${summary.unlabelledRows} unlabelled; credential reads ${replayOut.credentialReads}`,
        evidence: ["logs/step04-ingestion-replay-cli.json"],
        facts: {
          digest: replayOut.output.digest,
          rowCounts: summary.rowCounts,
          adapterModes: replayOut.adapterModes,
        },
      };
    },
  );

  // 5 ------------------------------------------------------------------------------------------------------------
  const ch = createCh();
  const redis = new Redis(process.env.NEARESIS_REDIS_URL ?? "redis://127.0.0.1:56379", {
    maxRetriesPerRequest: 2,
  });
  const secret = defaultCubeSecret();
  const sessionForCube = () => ({
    tenantId: ctx.orgId ?? "demo-tenant",
    workspaceId: ctx.workspaceId ?? "demo-workspace",
    principalId: ctx.userId ?? "demo-principal",
    aclClasses: ["member"],
  });
  await rec.step(5, "Normalize into ClickHouse (services/analytics loader)", "fixture-backed", async () => {
    if (!replayOut) return { status: "BLOCKED", detail: "no replay output from step 4", owner: "A11" };
    // Cube reads the shared `nearesis` database: serialize with every other Cube-backed suite.
    release = await acquireDataLock(redis as never, 900_000);
    await resetData(ch);
    const loaded = await loadNormalized(ch, replayOut.output);
    await settleRollups(ch, CUBE, signCubeToken(secret, sessionForCube()));
    const counts: Record<string, string> = {};
    let mismatches = 0;
    for (const [table, n] of Object.entries(loaded)) {
      const r = await queryRows<{ c: string }>(ch, `SELECT toString(count()) AS c FROM ${table} FINAL`);
      counts[table] = r[0]!.c;
      // ReplacingMergeTree FINAL collapses re-delivered keys, so FINAL <= loaded; equality holds for unique keys.
      if (Number(r[0]!.c) > n) mismatches++;
    }
    const swaps = Number(counts.intents_swaps ?? 0);
    return {
      status: mismatches === 0 && swaps > 0 ? "PASS" : "FAIL",
      detail: `loaded ${Object.values(loaded).reduce((a, b) => a + b, 0)} rows into ${Object.keys(loaded).length} tables (intents_swaps FINAL=${counts.intents_swaps}); Cube rollups settled; data lock held until the demo's Cube queries finish`,
      facts: { loaded, finalCounts: counts, digest: replayOut.output.digest },
    };
  });

  // 6 ------------------------------------------------------------------------------------------------------------
  await rec.step(6, "Query certified metrics through Cube (semantic gateway)", "fixture-backed", async () => {
    if (!release) return { status: "BLOCKED", detail: "no loaded data from step 5", owner: "A11" };
    const registry = loadRegistry();
    const gateway = createGateway({
      cubeUrl: CUBE,
      cubeSecret: secret,
      redis: redis as never,
      registry,
      policyResolver: () => ({ ...DEFAULT_POLICY }),
      clock: () => new Date(),
      ch,
    });
    const session = sessionForCube();
    const q = {
      semanticVersion: registry.semanticVersion,
      measures: ["intents.oneclick_completed_swap_count"],
      dimensions: [],
      time: { field: "intents.day", from: "2026-10-01T00:00:00Z", to: "2026-10-11T00:00:00Z", grain: "day" },
      filters: [],
      order: [],
      limit: 1000,
    };
    const res = await gateway.query(session, q);
    if (!res.ok) return { status: "FAIL", detail: `gateway rejected: ${res.error.reasonCode}` };
    ctx.queryHash = res.queryHash;
    const raw = await queryRows<{ d: string; v: string }>(
      ch,
      "SELECT toString(created_day) AS d, toString(countIf(status = 'SUCCESS')) AS v FROM intents_swaps FINAL GROUP BY d ORDER BY d",
    );
    const env = res.envelope as unknown as { rows?: unknown[]; columns?: unknown[]; provenance?: unknown };
    rec.writeJson("step06-semantic-query.json", {
      session: { ...session, principalId: "redacted-by-demo" },
      query: q,
      queryHash: res.queryHash,
      cache: res.cache,
      envelope: res.envelope,
      independentRawSql: raw,
    });
    const unknownRegistry = await gateway.query(session, {
      ...q,
      measures: ["intents.not_a_certified_metric"],
    });
    const refused = !unknownRegistry.ok;
    return {
      status: refused ? "PASS" : "FAIL",
      detail: `certified metric intents.oneclick_completed_swap_count (semantic ${registry.semanticVersion}, model ${registry.contentHash.slice(0, 12)}) returned ${(env.rows ?? []).length} day rows (gateway zero-fills no-data days; ${raw.length} days have raw swaps), queryHash ${res.queryHash.slice(0, 16)}..., cache ${res.cache}; uncertified metric refused: ${refused}`,
      evidence: ["step06-semantic-query.json"],
      facts: {
        queryHash: res.queryHash,
        semanticVersion: registry.semanticVersion,
        semanticModelHash: registry.contentHash,
        cache: res.cache,
        uncertifiedRefused: refused,
      },
    };
  });
  await agentSteps(
    {
      rec,
      API,
      WEB,
      adminUrl: ADMIN_URL,
      Pool: pg.Pool,
      ctx,
      webUp,
      flags,
    },
    worker,
  );
  if (release) await release();
  release = undefined;

  // 17 -----------------------------------------------------------------------------------------------------------
  await rec.step(
    17,
    "Run the milestone acceptance suites (G00 .. G05)",
    "fixture-backed + live",
    async () => {
      // Per the lead: do not re-run the full suite; cite the committed final sequential run.
      const tsv = join(BIBLE, "reports", "RUNS", "FINAL-RUN-d96cc1a.tsv");
      const lines = readFileSync(tsv, "utf8").trim().split("\n");
      const tests = lines.filter((l) => !l.startsWith("DONE")).map((l) => l.split("\t"));
      const index = JSON.parse(readFileSync(join(APP_ROOT, "tests", "TEST_INDEX.json"), "utf8")) as {
        tests: Array<{ testId: string; gate: string }>;
      };
      const gateOf = new Map(index.tests.map((t) => [t.testId, t.gate]));
      const summary: Record<string, { total: number; PASS: number }> = {};
      const nonPass: string[] = [];
      for (const [id, verdict] of tests) {
        const g = gateOf.get(id!) ?? "other";
        const e = (summary[g] ??= { total: 0, PASS: 0 });
        e.total++;
        if (verdict === "PASS") e.PASS++;
        else nonPass.push(`${id}=${verdict}`);
      }
      rec.writeJson("step17-gates.json", {
        source: `committed final sequential run reports/RUNS/FINAL-RUN-d96cc1a.tsv (${lines.at(-1)}); evidence per test in reports/TESTS/<ID>; not re-executed by this demo`,
        summary,
        nonPass,
      });
      const gates = ["G00", "G01", "G02", "G03", "G04", "G05"];
      return {
        status: nonPass.length === 0 && tests.length > 0 ? "PASS" : "FAIL",
        detail: `cited, not re-run (final run d96cc1a): ${gates.map((g) => `${g} ${summary[g]?.PASS ?? 0}/${summary[g]?.total ?? 0}`).join(", ")}; ${tests.length} tests, ${nonPass.length} non-PASS`,
        evidence: ["step17-gates.json"],
        facts: { summary, nonPass },
      };
    },
  );

  // 18 -----------------------------------------------------------------------------------------------------------
  const finished = new Date().toISOString();
  const reportPath = writeReport({ rec, runId, startedAt, finished, commit: gitHead(), ctx });
  await rec.step(
    18,
    "Publish results to the build monitor (coordination event per step + release report)",
    "live",
    async () => {
      const ev = spawnSync("grep", ["-c", `demo.step.`, join(BIBLE, "coordination", "EVENTS.jsonl")], {
        encoding: "utf8",
      });
      return {
        status: reportPath ? "PASS" : "FAIL",
        detail: `one coordination event emitted per step (EVENTS.jsonl has ${ev.stdout.trim()} demo.step.* entries across runs); release report ${reportPath}`,
        evidence: ["steps.json"],
      };
    },
  );
  writeReport({ rec, runId, startedAt, finished: new Date().toISOString(), commit: gitHead(), ctx });

  const fails = rec.results.filter((r) => r.status === "FAIL").length;
  const blocked = rec.results.filter((r) => r.status === "BLOCKED").length;
  console.log(
    `\n${rec.results.filter((r) => r.status === "PASS").length} PASS, ${fails} FAIL, ${blocked} BLOCKED. Report: ${reportPath}`,
  );
  return fails ? 1 : blocked ? 3 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`demo aborted: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (release) await release().catch(() => undefined);
  if (!flags.has("--keep")) {
    if (worker.child) await worker.child.stop();
    for (const c of children) await c.stop();
  }
  await new Promise((r) => setTimeout(r, 200));
  process.exit(code);
}

/**
 * Cube recovery after a restart, proven on a DISPOSABLE Cube (never the shared nearesis-cube-live-1, which this test does
 * not touch): same pinned image, same model files, same ClickHouse database (nearesis_live, read-only use), its OWN rollup
 * schema (nearesis_preagg_a16rec, dropped afterwards), host port 4013, container `a16-cube-recovery`.
 * Sequence: start cold -> the swap rollup is built by the refresh worker and serves the query -> `docker restart` (graceful)
 * -> serves again, equal to source -> `docker kill` (crash) + start -> serves again, equal to source.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  cubeSqlPreAggregations,
  defaultCubeSecret,
  signCubeToken,
} from "../../services/analytics/src/index.ts";
import { liveAst, liveCh, liveGateway, M, rawByDay, session, type LiveGw } from "./lib.ts";

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });

const NAME = "a16-cube-recovery";
const PORT = 4013;
const URL_ = `http://127.0.0.1:${PORT}`;
const SCHEMA = "nearesis_preagg_a16rec";
const IMAGE = "cubejs/cube:v1.8.18@sha256:d382326a0d2786242c3992f3dd462efbea82d07b2823ecdc83d619d2d6f5dcb7";
const ROOT = new URL("../../services/analytics/cube-live/", import.meta.url).pathname;
const FROM = "2026-09-01T00:00:00Z";
const TO = "2026-11-01T00:00:00Z"; // complete days only: exact equality with source

const docker = (...a: string[]) =>
  execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chRaw = (sql: string) =>
  fetch("http://127.0.0.1:58123/", {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("nearesis:nearesis").toString("base64")}` },
    body: sql,
  });

async function ready(deadlineMs: number): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${URL_}/readyz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1_000);
  }
  throw new Error(`disposable Cube not ready within ${deadlineMs} ms`);
}

const ch = liveCh();
let gw: LiveGw;
const ctx = session("a16rec-tenant", "a16rec-ws");

/** Queries through the real gateway against the disposable Cube; retries while the rollup is still building. */
async function serve(
  deadlineMs: number,
): Promise<{ rows: Array<Array<string | number | null>>; elapsedMs: number; attempts: number }> {
  const t0 = Date.now();
  let attempts = 0;
  let last = "";
  while (Date.now() - t0 < deadlineMs) {
    attempts++;
    // a distinct limit per attempt so the gateway result cache never answers: this must reach Cube
    const r = await gw.gateway.query(
      ctx,
      liveAst(
        { measures: [M.swaps, M.completed], limit: 2_000 + attempts + Math.floor(Math.random() * 1_000) },
        FROM,
        TO,
      ),
    );
    if (r.ok) return { rows: r.envelope.rows as never, elapsedMs: Date.now() - t0, attempts };
    last = `${r.error.reasonCode}: ${r.error.message}`;
    await sleep(3_000);
  }
  throw new Error(`no result within ${deadlineMs} ms; last error ${last}`);
}

async function expectEqualsSource(rows: Array<Array<string | number | null>>) {
  const raw = await rawByDay(ch, "2026-09-01", "2026-11-01");
  expect(rows.length).toBe(61);
  for (const r of rows) {
    const d = String(r[0]).slice(0, 10);
    expect(String(r[1]), `swaps ${d}`).toBe(raw.get(d)!.swaps);
    expect(String(r[2]), `completed ${d}`).toBe(raw.get(d)!.completed);
  }
}

async function usedRollups(): Promise<string[]> {
  const token = signCubeToken(defaultCubeSecret(), {
    tenantId: "a16rec-tenant",
    workspaceId: "a16rec-ws",
    principalId: "a16",
  });
  const u = await cubeSqlPreAggregations(URL_, token, {
    measures: ["intents_swaps_live.swap_count"],
    timeDimensions: [
      { dimension: "intents_swaps_live.day", granularity: "day", dateRange: ["2026-09-01", "2026-09-30"] },
    ],
    timezone: "UTC",
  });
  return u.map((x) => x.preAggregationId);
}

const rollupTables = async () =>
  (await (await chRaw(`SELECT name FROM system.tables WHERE database = '${SCHEMA}' ORDER BY name`)).text())
    .split("\n")
    .filter(Boolean);

beforeAll(async () => {
  docker("rm", "-f", NAME).toString();
  await chRaw(`DROP DATABASE IF EXISTS ${SCHEMA}`);
  docker(
    "run",
    "-d",
    "--name",
    NAME,
    "--network",
    "nearesis_default",
    "-p",
    `127.0.0.1:${PORT}:4000`,
    "--memory",
    "1024m",
    "-e",
    "CUBEJS_DEV_MODE=false",
    "-e",
    "CUBEJS_DB_TYPE=clickhouse",
    "-e",
    "CUBEJS_DB_HOST=clickhouse",
    "-e",
    "CUBEJS_DB_PORT=8123",
    "-e",
    "CUBEJS_DB_NAME=nearesis_live",
    "-e",
    "CUBEJS_DB_USER=nearesis",
    "-e",
    "CUBEJS_DB_PASS=nearesis",
    "-e",
    `CUBEJS_API_SECRET=${process.env.CUBEJS_API_SECRET ?? "nearesis-dev-cube-secret-not-for-production"}`,
    "-e",
    `CUBEJS_PRE_AGGREGATIONS_SCHEMA=${SCHEMA}`,
    "-e",
    "CUBEJS_REFRESH_WORKER=true",
    "-e",
    "CUBEJS_SCHEDULED_REFRESH_DEFAULT=true",
    "-e",
    "CUBEJS_SCHEDULED_REFRESH_TIMER=2",
    "-e",
    "CUBEJS_CACHE_AND_QUEUE_DRIVER=memory",
    "-e",
    "CUBEJS_LOG_LEVEL=warn",
    "-e",
    "CUBEJS_TELEMETRY=false",
    "-v",
    `${ROOT}model:/cube/conf/model:ro`,
    "-v",
    `${ROOT}cube.js:/cube/conf/cube.js:ro`,
    IMAGE,
  );
  await ready(180_000);
  // rollupAware cost on, but no warm-up queries of its own: the refresh worker builds the rollup
  gw = liveGateway({ cubeUrl: URL_ });
});
afterAll(async () => {
  await gw?.close();
  await ch.close();
  try {
    docker("rm", "-f", NAME);
  } catch {
    /* already gone */
  }
  await chRaw(`DROP DATABASE IF EXISTS ${SCHEMA}`);
});

it("cold start: the refresh worker builds the swap rollup, the query is served from it and equals the source", async () => {
  const a = await serve(600_000);
  await expectEqualsSource(a.rows);
  expect(await usedRollups()).toContain("intents_swaps_live_facts.daily_swaps_rollup");
  expect(
    (await rollupTables()).some((t) => t.startsWith("intents_swaps_live_facts_daily_swaps_rollup_")),
  ).toBe(true);
  console.log(`cold build+serve: ${a.elapsedMs} ms in ${a.attempts} attempt(s)`);
});

it("recovers after a graceful restart (docker restart): serves again from the rollup, equal to the source", async () => {
  const before = await rollupTables();
  docker("restart", NAME);
  await ready(180_000);
  const a = await serve(600_000);
  await expectEqualsSource(a.rows);
  expect(await usedRollups()).toContain("intents_swaps_live_facts.daily_swaps_rollup");
  const after = await rollupTables();
  expect(after.length).toBeGreaterThanOrEqual(before.length > 0 ? 1 : 0);
  console.log(
    `restart recovery: ${a.elapsedMs} ms in ${a.attempts} attempt(s); rollup tables ${before.length} -> ${after.length}`,
  );
});

it("recovers after a crash (docker kill, then start): serves again from the rollup, equal to the source", async () => {
  docker("kill", NAME);
  docker("start", NAME);
  await ready(180_000);
  const a = await serve(600_000);
  await expectEqualsSource(a.rows);
  expect(await usedRollups()).toContain("intents_swaps_live_facts.daily_swaps_rollup");
  console.log(`crash recovery: ${a.elapsedMs} ms in ${a.attempts} attempt(s)`);
});

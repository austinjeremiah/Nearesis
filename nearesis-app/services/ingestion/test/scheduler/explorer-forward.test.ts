import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StateStore } from "../../src/backfill/state.ts";
import { loadConfig } from "../../src/scheduler/config.ts";
import { nextForwardWindow, runExplorerForward } from "../../src/scheduler/explorer-forward.ts";
import { SchedulerStateStore } from "../../src/scheduler/state.ts";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => {
  await env.close();
}, 60_000);

const cfg = { ...loadConfig({}), explorerMaxPagesPerTick: 40 };
const inserted: Array<{ table: string; values: Array<Record<string, unknown>> }> = [];
const ch = {
  insert: async (a: (typeof inserted)[number]) => void inserted.push(a),
} as unknown as ClickHouseClient;
/** Each test uses its own watermark so its window (and cursor stream) is distinct inside the shared test database. */
const rig = (n: string, watermarkHoursAfter?: number) => {
  mkdirSync(join(env.tmp, n), { recursive: true });
  const sched = new SchedulerStateStore(join(env.tmp, n, "state.json"));
  if (watermarkHoursAfter !== undefined && sched.state.explorer.watermarkMs === null)
    sched.state.explorer.watermarkMs =
      Date.parse("2026-11-10T00:00:00Z") + watermarkHoursAfter * 3_600_000 + cfg.explorerOverlapMs;
  return {
    sched,
    loadStore: new StateStore(join(env.tmp, n, "load.json"), "2026-11-10", "2026-11-10"),
  };
};
const base = (r: ReturnType<typeof rig>) => ({
  ch,
  db: env.tdb.db,
  archive: env.archive,
  creds: env.creds,
  redis: env.redis,
  clock: env.clock,
  cfg,
  pageSize: 5,
  skipLoad: true,
  blockerDir: join(env.tmp, "blockers"),
  ...r,
});

describe("explorer forward window", () => {
  it("starts the day after the backfill window, then follows the watermark minus the overlap", () => {
    const first = nextForwardWindow(Date.parse("2026-11-11T12:00:30Z"), null, cfg);
    expect(first.startUnix).toBe(Date.parse("2026-11-10T00:00:00Z") / 1000 - 1);
    expect(first.endUnix).toBe(Date.parse("2026-11-11T12:00:30Z") / 1000);
    const wm = Date.parse("2026-11-11T12:00:30Z");
    const next = nextForwardWindow(wm + 3_600_000, wm, cfg);
    expect(next.startUnix).toBe((wm - cfg.explorerOverlapMs) / 1000 - 1);
    expect(next.streamKey).not.toBe(first.streamKey);
  });
});

describe("explorer forward collection (fixture server, real Postgres and Redis)", () => {
  it("collects the window through the committed-cursor collector and advances the watermark", async () => {
    const r = rig("fwd1");
    const t0 = env.clock.now();
    const server = new ExplorerFixtureServer(env.clock, loadPages("fx.explorer.pages-3"));
    const res = await runExplorerForward({ ...base(r), fetchImpl: server.fetchImpl });
    expect(res.status).toBe("complete");
    expect(res.swapsInserted).toBe(13);
    expect(r.sched.state.explorer.inflight).toBeNull();
    expect(r.sched.state.explorer.watermarkMs).toBe(Math.floor(t0 / 1000) * 1000);
    const q = server.requests[0]!.query;
    expect(q.startTimestampUnix).toBe(String(Date.parse("2026-11-10T00:00:00Z") / 1000 - 1));
    expect(q.endTimestampUnix).toBe(String(Math.floor(t0 / 1000)));
    expect(server.requests.every((x) => x.path === "/api/v0/transactions" && x.method === "GET")).toBe(true);
  });

  it("an unfinished window is kept and resumed from the committed cursor, with no duplicate swaps", async () => {
    const r = rig("fwd2", 1);
    const server = new ExplorerFixtureServer(env.clock, loadPages("fx.explorer.pages-3"));
    const deps = { ...base(r), cfg: { ...cfg, explorerMaxPagesPerTick: 1 }, fetchImpl: server.fetchImpl };
    const a = await runExplorerForward(deps);
    expect(a.complete).toBe(false);
    const key = r.sched.state.explorer.inflight!.streamKey;
    const reopened = rig("fwd2", 1); // new process
    expect(reopened.sched.state.explorer.inflight!.streamKey).toBe(key);
    const before = server.requests.length;
    const b = await runExplorerForward({
      ...base(reopened),
      cfg: { ...cfg, explorerMaxPagesPerTick: 40 },
      fetchImpl: server.fetchImpl,
    });
    expect(b.status).toBe("complete");
    expect(server.requests.length - before).toBe(2); // pages 2 and 3 only; page 1 is not fetched again
    const n = await env.tdb.db.query<{ n: string; d: string }>(
      "SELECT count(*)::text AS n, count(DISTINCT swap_key)::text AS d FROM ingestion.explorer_swaps",
    );
    expect(n.rows[0]!.n).toBe(n.rows[0]!.d); // one row per swap key
    expect(b.swapsInserted).toBe(0); // all 13 were already stored by the first test (same fixture); resuming adds none twice
  });

  it("shares the rate limiter with other Explorer runs: combined requests stay at least 5 s apart", async () => {
    const r = rig("fwd3", 2);
    const server = new ExplorerFixtureServer(env.clock, loadPages("fx.explorer.pages-3"));
    await runExplorerForward({ ...base(r), fetchImpl: server.fetchImpl });
    // a backfill-style collector on its own stream, same credential, same clock
    await env
      .collector(server.fetchImpl, { streamKey: "transactions:live-backfill-test" })
      .run({ maxPages: 3 });
    const times = server.requests.map((x) => x.atMs).sort((a, b) => a - b);
    expect(times.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(5000);
  });

  it("an auth failure keeps the window open and records one explicit gap (never zeros)", async () => {
    const r = rig("fwd4", 3);
    inserted.length = 0;
    const server = new ExplorerFixtureServer(env.clock, loadPages("fx.explorer.pages-3"));
    server.failFrom = { page: 1, status: 401 };
    const a = await runExplorerForward({ ...base(r), fetchImpl: server.fetchImpl });
    const wm0 = r.sched.state.explorer.watermarkMs;
    expect(a.status).toBe("auth_blocked");
    expect(r.sched.state.explorer.inflight).not.toBeNull();
    expect(r.sched.state.explorer.watermarkMs).toBe(wm0); // not advanced past an uncollected window
    const gaps = () => inserted.filter((i) => i.table === "quality_gaps").flatMap((i) => i.values);
    expect(gaps()).toHaveLength(1);
    expect(gaps()[0]).toMatchObject({
      provider_id: "near-explorer",
      dataset: "intents_swaps",
      reason_code: "AUTH_REJECTED",
      state: "unavailable",
      source_label: "LIVE",
    });
  });
});

/**
 * PERF08: shared collectors never exceed the Explorer ceiling and the quote sampler reports drift and missed samples as
 * gaps (ch.13 "Global rate and scheduling"; ch.16b 6.2). Fixture half, 10 minutes of mock time on a virtual clock:
 * four Explorer collectors plus the backfill stream (all ExplorerCollector instances) share one JWT, so one Redis token
 * bucket, against a rate-enforcing Explorer mock with a time-stamped request log; at the same time the quote sampler
 * (OneClickQuoteSampler through runQuoteRound) runs 12 cadence rounds of a 10 route x 4 size x 3 mode grid against a
 * separate rate-enforcing 1Click mock whose quota cannot serve the whole grid inside one cadence, with injected timeouts
 * and "no liquidity" answers. The live half is out of scope here (it needs credentials and may never exceed 12 quotes).
 * Negative control: a collector holding a different credential (bypassing the shared bucket) must FAIL (a).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { OneClickQuoteSampler } from "../../services/ingestion/src/adapters/oneclick.ts";
import { RawArchive } from "../../services/ingestion/src/archive/archive.ts";
import { FsObjectStore } from "../../services/ingestion/src/archive/object-store.ts";
import { ALLOW_ONECLICK, HttpClient } from "../../services/ingestion/src/http/client.ts";
import { CredentialSource } from "../../services/ingestion/src/http/credentials.ts";
import { loadConfig } from "../../services/ingestion/src/scheduler/config.ts";
import type { RouteDef } from "../../services/ingestion/src/scheduler/plan.ts";
import { runQuoteRound, type QuoteRow } from "../../services/ingestion/src/scheduler/quotes.ts";
import { SchedulerStateStore } from "../../services/ingestion/src/scheduler/state.ts";
import { ExplorerFixtureServer, FixtureServer } from "../../services/ingestion/src/testing/servers.ts";
import type { FakeResponse, ServedRequest } from "../../services/ingestion/src/testing/servers.ts";
import { loadPages, setupEnv, uniqueJwt } from "../../services/ingestion/test/helpers/env.ts";
import type { TestEnv } from "../../services/ingestion/test/helpers/env.ts";
import { DRYRUN, sha256Text, stats } from "./_reference.ts";
import { evidenceBase, gateB, referenceB, thr } from "./_b.ts";
import { VirtualClock } from "./_vclock.ts";

const th = thr("PERF08");
const EXPLORER_MS = 5000;
const START = Date.parse("2026-11-11T10:00:00Z");
const RUN_MS = th.mockMinutes! * 60_000;
const CADENCE_MS = th.cadenceMs!;
const ROUNDS = th.rounds!;
const QUOTE_QUOTA_GAP_MS = 3000; // 1Click mock: one quote per 3 s, so 120 slots need 360 s > the 300 s cadence
const ASSETS = ["perfa", "perfb", "perfc", "perfd", "perfe"].map((a) => `nep141:${a}.near`);
const ROUTES: RouteDef[] = ASSETS.flatMap((o) =>
  ASSETS.filter((d) => d !== o).map((d) => ({ originAsset: o, destinationAsset: d })),
).slice(0, 10);
const TOKENS = ASSETS.map((assetId) => ({
  assetId,
  decimals: 6,
  blockchain: "near",
  symbol: assetId,
  price: 1,
  priceUpdatedAt: "2026-11-11T09:00:00Z",
}));
export const FIXTURE_SPEC = {
  collectors: 4,
  backfillStream: "transactions:live-backfill",
  mockMinutes: th.mockMinutes,
  explorerPages: 150,
  sampler: {
    routes: ROUTES.length,
    sizes: [10, 100, 1000, 10000],
    modes: ["public", "basic", "advanced"],
    rounds: ROUNDS,
    cadenceMs: CADENCE_MS,
    quotaGapMs: QUOTE_QUOTA_GAP_MS,
  },
  injected: "every 7th attempted quote times out, every 11th answers insufficient liquidity",
  control: "one collector with its own credential",
};

/** Pure judgements; the negative control runs the same code. */
export const minGapMs = (ts: number[]): number => {
  const s = [...ts].sort((a, b) => a - b);
  return s.length < 2 ? Infinity : Math.min(...s.slice(1).map((t, i) => t - s[i]!));
};
export const ceilingHolds = (ts: number[]) => minGapMs(ts) >= EXPLORER_MS;

let env: TestEnv | null = null;
let tmp = "";
const g = gateB(import.meta.url);
beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  env = await setupEnv();
  tmp = mkdtempSync(join(tmpdir(), "perf08-"));
}, 120_000);
afterAll(async () => {
  await env?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}, 60_000);

class OneClickMock extends FixtureServer {
  attempts = 0;
  rejected = 0;
  private lastQuote = -Infinity;
  constructor(clock: VirtualClock) {
    super(clock);
  }
  protected handle(req: ServedRequest): FakeResponse {
    if (req.method === "GET" && req.path === "/v0/tokens")
      return { status: 200, body: JSON.stringify(TOKENS) };
    const b = req.body as { amount: string; dry?: boolean };
    // the 1Click quota is its own bucket: never the Explorer's
    if (req.atMs - this.lastQuote < QUOTE_QUOTA_GAP_MS) {
      this.rejected++;
      return { status: 429, headers: { "retry-after": "3" }, body: JSON.stringify({ message: "quota" }) };
    }
    this.lastQuote = req.atMs;
    this.attempts++;
    if (this.attempts % 7 === 0) throw Object.assign(new Error("aborted"), { name: "AbortError" }); // timeout
    if (this.attempts % 11 === 0)
      return { status: 400, body: JSON.stringify({ message: "insufficient liquidity" }) };
    const out = String((BigInt(b.amount) * 999n) / 1000n);
    return {
      status: 200,
      body: JSON.stringify({
        correlationId: `c${this.attempts}`,
        timestamp: new Date(req.atMs).toISOString(),
        quoteRequest: {},
        quote: {
          amountIn: b.amount,
          amountInFormatted: "1",
          amountInUsd: String(Number(b.amount) / 1e6),
          minAmountIn: b.amount,
          amountOut: out,
          amountOutFormatted: `${BigInt(out) / 1000000n}.${(BigInt(out) % 1000000n).toString().padStart(6, "0")}`,
          amountOutUsd: String(Number(out) / 1e6),
          minAmountOut: out,
          timeEstimate: 30,
        },
      }),
    };
  }
}

it("PERF08: shared collectors never exceed the Explorer ceiling and the sampler reports gaps honestly", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF08", observed: "not executed", blocked: g.reason });
    return;
  }
  const e = env!;
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF08 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF08).toBe(fixtureHash);

  // ---- Explorer pages: the fixture template cloned into 150 distinct pages
  const template = loadPages("fx.explorer.pages-3")[0]!;
  const pages = Array.from({ length: FIXTURE_SPEC.explorerPages }, (_, p) =>
    template.map((t, i) => ({ ...t, depositAddress: `perf08-${p}-${i}`, depositMemo: null })),
  );
  const clock = new VirtualClock(START);
  const explorer = new ExplorerFixtureServer(clock, pages);
  let lastOk = -Infinity;
  let enforcedRejections = 0;
  explorer.intercept((r) => {
    if (r.atMs - lastOk < EXPLORER_MS) {
      enforcedRejections++;
      return {
        status: 429,
        headers: { "retry-after": "5" },
        body: JSON.stringify({ status: 429, error: { code: "RATE", message: "slow down" } }),
      };
    }
    lastOk = r.atMs;
    return undefined;
  });
  const streams = ["stream:c1", "stream:c2", "stream:c3", "stream:c4", "transactions:live-backfill"];
  const collectors = streams.map((streamKey) => e.collector(explorer.fetchImpl, { clock, streamKey }));

  // ---- sampler rig
  const oneclick = new OneClickMock(clock);
  // 800 ms of mock network latency per request, so rounds really take time and drift shows
  const slowFetch: typeof oneclick.fetchImpl = async (url, init) => {
    await clock.sleep(800);
    return oneclick.fetchImpl(url, init);
  };
  const http = new HttpClient({ allow: [ALLOW_ONECLICK], fetchImpl: slowFetch, clock });
  const archive = new RawArchive(new FsObjectStore(join(tmp, "raw")), null);
  const sampler = new OneClickQuoteSampler({ http, archive, clock, sourceEnvironment: "live" });
  const store = new SchedulerStateStore(join(tmp, "state.json"));
  const cfg = {
    ...loadConfig({}),
    quoteIntervalMs: CADENCE_MS,
    quotePaceMs: QUOTE_QUOTA_GAP_MS,
    quoteNotionalsUsd: [10, 100, 1000, 10000],
    quoteLimit: 0,
  };
  const rows: QuoteRow[] = [];
  const rounds: Array<{
    scheduledMs: number;
    startMs: number;
    endMs: number;
    attempted: number;
    unavailable: number;
    planned: number;
  }> = [];

  let explorerDone = 0;
  const collectorActors = collectors.map((c) =>
    clock.actor(async () => {
      while (clock.now() < START + RUN_MS) {
        const r = await c.run({ maxPages: 1 });
        if (r.status === "complete") break;
      }
      explorerDone++;
    }),
  );
  const samplerActor = clock.actor(async () => {
    for (let r = 0; r < ROUNDS; r++) {
      const scheduled = Math.floor(START / CADENCE_MS) * CADENCE_MS + (r + 1) * CADENCE_MS;
      if (clock.now() < scheduled) await clock.sleep(scheduled - clock.now());
      const startMs = clock.now();
      const res = await runQuoteRound({
        sampler,
        creds: CredentialSource.fromMap({ NEARESIS_QUOTE_ADDRESS_NEAR: "dry-recipient.near" }),
        cfg,
        store,
        nowMs: () => clock.now(),
        sleep: (ms) => clock.sleep(ms),
        insert: async (x) => void rows.push(...x),
        routes: ROUTES,
      });
      rounds.push({
        scheduledMs: scheduled,
        startMs,
        endMs: clock.now(),
        attempted: res.attempted,
        unavailable: res.unavailable,
        planned: res.planned,
      });
    }
  });
  let samplerDone = false;
  void samplerActor.then(() => (samplerDone = true));
  await Promise.all([
    clock.drive(() => samplerDone && explorerDone === collectors.length),
    ...collectorActors,
    samplerActor,
  ]);

  // ---- (a) Explorer ceiling over the whole run
  const okReqs = explorer.requests.filter((r) => r.status !== 429).map((r) => r.atMs);
  const allReqs = explorer.requests.map((r) => r.atMs);
  const minGap = minGapMs(allReqs);
  const minGapAccepted = minGapMs(okReqs);
  const grants = collectors.flatMap((c) => c.grantLog);
  const minGrantGap = minGapMs(grants);
  const perCollector = collectors.map((c, i) => ({ stream: streams[i], grants: c.grantLog.length }));

  // ---- negative control: a collector with its own credential bypasses the shared bucket
  const ctlClock = new VirtualClock(clock.now() + 60_000); // after the shared bucket's last grant
  const ctlServer = new ExplorerFixtureServer(ctlClock, pages);
  const jwt2 = uniqueJwt();
  const ctlCreds = CredentialSource.fromMap({ INTENTS_EXPLORER_JWT: jwt2 });
  void ctlCreds;
  const ctlA = e.collector(ctlServer.fetchImpl, { clock: ctlClock, streamKey: "ctl:a" });
  const ctlB = e.collector(ctlServer.fetchImpl, {
    clock: ctlClock,
    streamKey: "ctl:b",
    credentials: CredentialSource.fromMap({ INTENTS_EXPLORER_JWT: jwt2 }),
  });
  let ctlDone = 0;
  const ctlActors = [ctlA, ctlB].map((c) =>
    ctlClock.actor(async () => {
      for (let i = 0; i < 12; i++) await c.run({ maxPages: 1 });
      ctlDone++;
    }),
  );
  await Promise.all([ctlClock.drive(() => ctlDone === 2), ...ctlActors]);
  const controlFails = !ceilingHolds(ctlServer.requests.map((r) => r.atMs));

  // ---- (b)-(d) sampler honesty
  const key = (r: QuoteRow) => [r.route_id, r.notional_usd, r.privacy_mode, r.scheduled_bucket_utc].join("|");
  const byKey = new Map<string, QuoteRow[]>();
  for (const r of rows) byKey.set(key(r), [...(byKey.get(key(r)) ?? []), r]);
  const expectedSlots = ROUTES.length * 4 * 3 * ROUNDS;
  const unavailable = rows.filter((r) => r.slot === "unavailable");
  const observed = rows.filter((r) => r.slot === "observed");
  const unavailableNoReason = unavailable.filter((r) => !r.reason).length;
  const unavailableFilled = unavailable.filter(
    (r) => r.amount_out_base_units != null || r.amount_in_usd != null || r.class != null,
  ).length;
  const classes: Record<string, number> = {};
  for (const r of observed) classes[String(r.class)] = (classes[String(r.class)] ?? 0) + 1;
  const reasons: Record<string, number> = {};
  for (const r of unavailable) reasons[String(r.reason)] = (reasons[String(r.reason)] ?? 0) + 1;
  const drift = rounds.map((r) => r.startMs - r.scheduledMs);
  const cadenceGaps = rounds.slice(1).map((r, i) => r.startMs - rounds[i]!.startMs);
  const quoteReqs = oneclick.requests.filter((r) => r.method === "POST");
  const notDry = quoteReqs.filter((r) => (r.body as { dry?: unknown } | null)?.dry !== true).length;
  const explorerOnOneClick = explorer.requests.filter((r) => r.path.includes("quote")).length;

  if (DRYRUN)
    process.stderr.write(
      "DRYRUN " +
        JSON.stringify({
          explorerRequests: allReqs.length,
          minGap,
          minGapAccepted,
          minGrantGap,
          enforcedRejections,
          perCollector,
          rows: rows.length,
          expectedSlots,
          distinctKeys: byKey.size,
          unavailable: unavailable.length,
          observed: observed.length,
          classes,
          reasons,
          unavailableNoReason,
          unavailableFilled,
          drift,
          cadenceGaps,
          quoteReqs: quoteReqs.length,
          notDry,
          oneclickRejected: oneclick.rejected,
          control: {
            requests: ctlServer.requests.length,
            minGap: minGapMs(ctlServer.requests.map((r) => r.atMs)),
            controlFails,
          },
          rounds: rounds.slice(0, 3),
        }) +
        "\n",
    );
  expect(controlFails).toBe(true);
  expect(enforcedRejections).toBe(0);
  expect(ceilingHolds(allReqs)).toBe(true);
  expect(minGrantGap).toBeGreaterThanOrEqual(EXPLORER_MS);
  expect(rounds.length).toBe(ROUNDS);
  expect(byKey.size).toBe(expectedSlots);
  expect([...byKey.values()].every((v) => v.length === 1)).toBe(true);
  expect(unavailable.length).toBeGreaterThan(0); // the quota cannot serve the grid inside one cadence
  expect(unavailableNoReason).toBe(0);
  expect(unavailableFilled).toBe(0);
  expect(classes.TIMEOUT).toBeGreaterThan(0);
  expect(classes.NO_QUOTE).toBeGreaterThan(0);
  expect(notDry).toBe(0);
  expect(explorerOnOneClick).toBe(0);
  if (DRYRUN) return;

  observe({
    testId: "PERF08",
    observed: `${collectors.length} Explorer collectors (one is the backfill stream) on one credential over ${th.mockMinutes} min of mock time: ${allReqs.length} requests, minimum gap between any two ${minGap} ms (>= ${EXPLORER_MS}), limiter grants minimum gap ${minGrantGap} ms, rate-enforcing mock rejections ${enforcedRejections}. Sampler, ${ROUNDS} rounds of ${ROUTES.length} routes x 4 sizes x 3 modes (${expectedSlots} slots): ${observed.length} observed, ${unavailable.length} stored as unavailable with a reason (${JSON.stringify(reasons)}), none filled, each slot exactly one row; timeouts (${classes.TIMEOUT}) and no-liquidity (${classes.NO_QUOTE}) stored as different classes; round start drift ms ${JSON.stringify(drift)}, achieved cadence ms ${JSON.stringify(cadenceGaps)}; sampler quota use accounted separately (${quoteReqs.length} quote POSTs on the 1Click mock, 0 on the Explorer mock); all dry:true. Negative control (own credential, bypassing the shared bucket): min gap ${minGapMs(ctlServer.requests.map((r) => r.atMs))} ms, judged FAIL as required. Live half not run`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf08 fixture spec", sha256: fixtureHash },
        concurrency: { explorerCollectors: collectors.length, sampler: 1 },
        cacheState: "n/a (virtual clock, fresh Redis keys per credential)",
      }),
      explorer: {
        requests: allReqs.length,
        minGapMs: minGap,
        minGapAcceptedMs: minGapAccepted,
        minGrantGapMs: minGrantGap,
        perCollector,
        requestLogMs: allReqs.map((t) => t - START),
      },
      sampler: {
        rounds,
        driftMs: drift,
        driftStats: stats(drift),
        cadenceGapsMs: cadenceGaps,
        outcomes: { observed: observed.length, unavailable: unavailable.length, classes, reasons },
        quoteRequests: quoteReqs.length,
        mockRejections: oneclick.rejected,
      },
      negativeControl: {
        requests: ctlServer.requests.length,
        minGapMs: minGapMs(ctlServer.requests.map((r) => r.atMs)),
        judgedFail: controlFails,
      },
      liveHalf: "not run: requires credentials; bounded to 12 quotes by definition",
    },
  });
}, 900_000);

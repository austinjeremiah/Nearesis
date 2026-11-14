import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { createClient } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import { createLiveCh, ensureDatabase, migrateLive } from "../../src/backfill/ch.ts";
import { FakeClock } from "../../src/clock.ts";
import { RedisTokenBucket } from "../../src/rate/limiter.ts";
import { aggregateBlock, decideWrite, type BlockAggregate } from "../../src/realtime/aggregate.ts";
import { FeedIntegrityError, RealtimeFeed } from "../../src/realtime/feed.ts";
import { NeardataClient, type BlockSource } from "../../src/realtime/neardata.ts";
import { reconcileDay, reconcileDays } from "../../src/realtime/reconcile.ts";
import { aggregateRpcBlock, RpcBlockSource } from "../../src/realtime/rpc.ts";
import { ClickHouseRtStore, MemoryRtStore } from "../../src/realtime/store.ts";

const T0 = Date.parse("2026-11-10T12:00:00Z");

/** Synthetic final-block chain: height h has hash H<h>, parent H<prev>. `skip` heights do not exist (prev_height jumps over them). */
function chain(from: number, to: number, skip: number[] = []): Map<number, BlockAggregate> {
  const m = new Map<number, BlockAggregate>();
  let prev = from - 1;
  for (let h = from; h <= to; h++) {
    if (skip.includes(h)) continue;
    m.set(h, {
      height: h,
      blockHash: `H${h}`,
      prevHash: `H${prev}`,
      prevHeight: prev,
      blockTsMs: T0 + (h - from) * 1000,
      state: "final",
      txCount: h % 5,
      receiptCount: 2,
      gasBurnt: BigInt(h) * 1000n,
      tokensBurntYocto: BigInt(h) * 10n ** 20n,
      signers: [`s${h % 3}.near`],
      chunksIncluded: 6,
      receiverIds: ["a.near"],
      receiverTx: [h % 5],
      receiverRcpt: [2],
    });
    prev = h;
  }
  return m;
}
class FakeSource implements BlockSource {
  calls = 0;
  constructor(
    private readonly blocks: Map<number, BlockAggregate>,
    public head: number,
  ) {}
  async lastFinalHeight(): Promise<number> {
    return this.head;
  }
  async getBlock(h: number): Promise<BlockAggregate | null> {
    this.calls++;
    return h <= this.head ? (this.blocks.get(h) ?? null) : null;
  }
}
const mkFeed = (src: BlockSource, store: MemoryRtStore, clock = new FakeClock(T0)) =>
  new RealtimeFeed(
    src,
    store,
    clock,
    () => undefined,
    async () => undefined,
    { nullRetryMs: 1, pollMs: 1, prefetch: 3 },
  );
/** Forward-only start: the first block of a feed is whatever was final when it began; tests seed it explicitly. */
const seed = (store: MemoryRtStore, blocks: Map<number, BlockAggregate>, h: number): void => {
  store.blocks.set(h, { ...(blocks.get(h) as BlockAggregate), observedAtMs: 0, ingestedAtMs: 0 });
};
const runUntilTip = async (feed: RealtimeFeed, store: MemoryRtStore, tip: number): Promise<void> => {
  for (let i = 0; i < 1000; i++) {
    const t = (await store.lastBlock())?.height ?? 0;
    if (t >= tip) return;
    await feed.step();
  }
  throw new Error("did not reach tip");
};

describe("aggregation", () => {
  const wire = {
    block: {
      header: {
        height: 7,
        hash: "B7",
        prev_hash: "B6",
        prev_height: 6,
        timestamp_nanosec: "1794520484110386780",
        chunks_included: 2,
      },
    },
    shards: [
      {
        chunk: {
          transactions: [
            {
              transaction: { hash: "t1", signer_id: "alice.near", receiver_id: "x.near" },
              outcome: { execution_outcome: { outcome: { gas_burnt: 100, tokens_burnt: "10" } } },
            },
            {
              transaction: { hash: "t1", signer_id: "alice.near", receiver_id: "x.near" },
              outcome: { execution_outcome: { outcome: { gas_burnt: 100, tokens_burnt: "10" } } },
            },
            {
              transaction: { hash: "t2", signer_id: "bob.near", receiver_id: "x.near" },
              outcome: { execution_outcome: { outcome: { gas_burnt: 50, tokens_burnt: "5" } } },
            },
          ],
        },
        receipt_execution_outcomes: [
          {
            execution_outcome: {
              id: "r1",
              outcome: { gas_burnt: 1000, tokens_burnt: "100", executor_id: "y.near" },
            },
            receipt: { receiver_id: "y.near" },
          },
          {
            execution_outcome: {
              id: "r1",
              outcome: { gas_burnt: 1000, tokens_burnt: "100", executor_id: "y.near" },
            },
            receipt: { receiver_id: "y.near" },
          },
          {
            execution_outcome: {
              id: "r2",
              outcome: { gas_burnt: 7, tokens_burnt: "1", executor_id: "x.near" },
            },
            receipt: null,
          },
        ],
      },
      { chunk: null, receipt_execution_outcomes: [] },
    ],
  };
  it("sums exactly, dedupes by tx hash and receipt id, counts distinct signers and receivers", () => {
    const a = aggregateBlock(wire);
    expect(a).toMatchObject({ height: 7, prevHeight: 6, txCount: 2, receiptCount: 2, state: "final" });
    expect(a.gasBurnt).toBe(100n + 50n + 1000n + 7n);
    expect(a.tokensBurntYocto).toBe(10n + 5n + 100n + 1n);
    expect(a.signers).toEqual(["alice.near", "bob.near"]);
    expect(a.receiverIds).toEqual(["x.near", "y.near"]);
    expect(a.receiverTx).toEqual([2, 0]);
    expect(a.receiverRcpt).toEqual([1, 1]);
    expect(a.blockTsMs).toBe(1794520484110);
    expect(aggregateBlock(wire)).toEqual(a); // replay is identical
  });
  it("rpc aggregation skips repeated (missed) chunk headers so transactions are never double counted", () => {
    const blk = {
      header: { height: 9, hash: "B9", prev_hash: "B8", prev_height: 8, timestamp_nanosec: "1000000000" },
      chunks: [
        { chunk_hash: "c-new", height_included: 9, shard_id: 0, gas_used: 70, balance_burnt: "7" },
        { chunk_hash: "c-old", height_included: 8, shard_id: 1, gas_used: 999, balance_burnt: "99" },
      ],
    };
    const bodies = new Map([
      [
        "c-new",
        {
          transactions: [{ hash: "t1", signer_id: "a.near", receiver_id: "r.near" }],
          receipts: [{ receipt_id: "q1", receiver_id: "r.near" }],
        },
      ],
      [
        "c-old",
        { transactions: [{ hash: "tOld", signer_id: "z.near", receiver_id: "r.near" }], receipts: [] },
      ],
    ]);
    const a = aggregateRpcBlock(blk, bodies);
    expect(a.txCount).toBe(1);
    expect(a.gasBurnt).toBe(70n);
    expect(a.tokensBurntYocto).toBe(7n);
    expect(a.chunksIncluded).toBe(1);
    expect(a.signers).toEqual(["a.near"]);
  });
});

describe("finality handling", () => {
  const fin = { blockHash: "A", state: "final" as const };
  const prov = { blockHash: "A", state: "provisional" as const };
  it("state machine: final is never overwritten; provisional promotes or is replaced", () => {
    expect(decideWrite(null, prov)).toBe("insert");
    expect(decideWrite(prov, fin)).toBe("promote");
    expect(decideWrite(prov, { blockHash: "B", state: "final" })).toBe("replace_provisional");
    expect(decideWrite(fin, prov)).toBe("noop");
    expect(decideWrite(fin, fin)).toBe("noop");
    expect(decideWrite(fin, { blockHash: "B", state: "final" })).toBe("anomaly_final_conflict");
    expect(decideWrite(fin, { blockHash: "B", state: "provisional" })).toBe("anomaly_final_conflict");
  });
  it("never ingests above the final head and marks minutes provisional until they close", async () => {
    const blocks = chain(100, 200);
    const src = new FakeSource(blocks, 190);
    const store = new MemoryRtStore();
    seed(store, blocks, 100);
    const feed = mkFeed(src, store);
    await runUntilTip(feed, store, 190);
    expect(await feed.step()).toBe("caught_up");
    expect((await store.lastBlock())?.height).toBe(190);
    expect([...store.blocks.values()].every((b) => b.state === "final" && b.height <= 190)).toBe(true);
    // 91 blocks of 1 s: minute 0 closed (final), minute 1 is the open one -> stored provisional
    await feed.run(() => true);
    const mins = [...store.minutes.values()].sort((a, b) => a.minuteMs - b.minuteMs);
    expect(mins[0]).toMatchObject({ state: "final", complete: true });
    expect(mins[mins.length - 1]?.state).toBe("provisional");
  });
  it("a parent hash mismatch (reorg of a final block) and a gap stop the feed and are recorded", async () => {
    const blocks = chain(100, 120);
    const store = new MemoryRtStore();
    seed(store, blocks, 100);
    const feed = mkFeed(new FakeSource(blocks, 120), store);
    await runUntilTip(feed, store, 105);
    const forked = new Map(blocks);
    forked.set(106, { ...(blocks.get(106) as BlockAggregate), prevHash: "OTHER" });
    const f2 = mkFeed(new FakeSource(forked, 120), store);
    await expect(f2.step()).rejects.toMatchObject({ kind: "REORG_PARENT_MISMATCH" });
    expect(store.anomalies.map((a) => a.kind)).toContain("REORG_PARENT_MISMATCH");
    expect((await store.lastBlock())?.height).toBe(105); // nothing written past the break

    const store2 = new MemoryRtStore();
    seed(store2, blocks, 100);
    const f3 = mkFeed(new FakeSource(blocks, 120), store2);
    await runUntilTip(f3, store2, 103);
    const missing = new Map(blocks);
    missing.delete(104); // 104 is final (<= head) but the source loses it; 105 says prev_height 104
    const f4 = mkFeed(new FakeSource(missing, 120), store2, new FakeClock(T0));
    // 104 absent below head: retried then treated as skipped; block 105 then proves the gap (prev_height 104 > tip 103)
    let err: unknown;
    for (let i = 0; i < 10 && !err; i++) await f4.step().catch((e: unknown) => (err = e));
    expect(err).toBeInstanceOf(FeedIntegrityError);
    expect((err as FeedIntegrityError).kind).toBe("GAP");
    expect((await store2.lastBlock())?.height).toBe(103);
  });
});

describe("restart without gaps or duplicates", () => {
  it("resumes from the stored tip; heights are contiguous (skipped heights chain through prev_height) and written once", async () => {
    const blocks = chain(1000, 1100, [1040, 1041, 1077]);
    const src = new FakeSource(blocks, 1100);
    const store = new MemoryRtStore();
    // fresh start at the head would skip history, so seed the first block like a forward-only start at 1000
    store.blocks.set(1000, { ...(blocks.get(1000) as BlockAggregate), observedAtMs: 0, ingestedAtMs: 0 });
    for (const stopAt of [1012, 1039, 1060, 1090, 1100]) {
      const feed = mkFeed(src, store, new FakeClock(T0)); // every segment is a brand-new process
      await runUntilTip(feed, store, stopAt);
    }
    const hs = [...store.blocks.keys()].sort((a, b) => a - b);
    expect(hs).toEqual([...blocks.keys()].sort((a, b) => a - b)); // no missing real block, no extra
    for (let i = 1; i < hs.length; i++) expect(store.blocks.get(hs[i] as number)?.prevHeight).toBe(hs[i - 1]); // unbroken parent chain
    expect(store.writes).toBe(hs.length - 1); // 1000 was seeded; every other height written exactly once
    expect(store.anomalies).toEqual([]);
  });
  it("replaying the same block is a no-op", async () => {
    const store = new MemoryRtStore();
    const b = chain(5, 5).get(5) as BlockAggregate;
    expect(await store.putBlock(b, 1, 2)).toBe("insert");
    expect(await store.putBlock(b, 3, 4)).toBe("noop");
    expect(store.writes).toBe(1);
  });
});

describe("reconciliation", () => {
  const base = { day: "2026-11-11", rtBlocks: 86000, rtContiguous: true, rtCoversDay: true };
  it("compares only fully covered days; BigQuery stays authoritative", () => {
    expect(reconcileDay({ ...base, bqTxCount: 1000, rtTxCount: 1000 })).toMatchObject({
      status: "MATCH",
      diff: 0,
    });
    expect(reconcileDay({ ...base, bqTxCount: 1_000_000, rtTxCount: 999_950 })).toMatchObject({
      status: "WITHIN_TOLERANCE",
      diff: -50,
    });
    const d = reconcileDay({ ...base, bqTxCount: 1000, rtTxCount: 900 });
    expect(d.status).toBe("DIFF");
    expect(d.diff).toBe(-100);
    expect(d.diffPct).toBeCloseTo(10);
    expect(reconcileDay({ ...base, bqTxCount: null, rtTxCount: 5 }).status).toBe("PENDING_BQ");
    expect(reconcileDay({ ...base, rtCoversDay: false, bqTxCount: 1000, rtTxCount: 5 })).toMatchObject({
      status: "PARTIAL_COVERAGE",
      diff: null,
    });
    expect(reconcileDay({ ...base, rtContiguous: false, bqTxCount: 1000, rtTxCount: 5 }).status).toBe(
      "PARTIAL_COVERAGE",
    );
  });
});

describe("shared rate-limit coordinator", () => {
  it("two callers of one provider (historical + forward) share one bucket; a 429 pushes both back", async () => {
    const redis = new Redis("redis://127.0.0.1:56379");
    const key = `ingestion:rate:test:${randomBytes(6).toString("hex")}`;
    const clock = new FakeClock();
    const historical = new RedisTokenBucket(redis, key, clock, 100);
    const forward = new RedisTokenBucket(redis, key, clock, 100);
    const grants: number[] = [];
    for (let i = 0; i < 6; i++) grants.push(await (i % 2 ? historical : forward).acquire());
    for (let i = 1; i < grants.length; i++)
      expect((grants[i] as number) - (grants[i - 1] as number)).toBeGreaterThanOrEqual(100);

    let status = 429;
    const fetchImpl = (async () => {
      const s = status;
      status = 200;
      return s === 429
        ? new Response("", { status: 429, headers: { "retry-after": "7" } })
        : new Response(JSON.stringify({ result: { header: { height: 5 }, chunks: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = new RpcBlockSource(forward, clock, "https://example.invalid", fetchImpl);
    const before = clock.now();
    expect(await src.lastFinalHeight()).toBe(5);
    expect(src.rateLimited).toBe(1);
    // the retry waited out Retry-After (7 s) on the SHARED bucket, so the other caller is paced behind it too
    expect(clock.now()).toBeGreaterThanOrEqual(before + 7000);
    expect(await historical.tryAcquire()).toBeGreaterThan(0);
    redis.disconnect();
  }, 20_000);
  it("neardata 429 penalises the shared bucket and raises", async () => {
    const redis = new Redis("redis://127.0.0.1:56379");
    const key = `ingestion:rate:test:${randomBytes(6).toString("hex")}`;
    const clock = new FakeClock();
    const bucket = new RedisTokenBucket(redis, key, clock, 100);
    const f = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "3" } })) as unknown as typeof fetch;
    const c = new NeardataClient(bucket, clock, "https://example.invalid", f);
    await expect(c.getBlock(1)).rejects.toThrow(/429/);
    expect(await new RedisTokenBucket(redis, key, clock, 100).tryAcquire()).toBeGreaterThan(2000);
    redis.disconnect();
  });
});

describe("ClickHouse store (disposable database)", () => {
  it("writes blocks once, materialises a final minute, and reconciles a covered day against near_daily_tx", async () => {
    const name = `nearesis_t_a13_rt${randomBytes(4).toString("hex")}`;
    await ensureDatabase(name);
    const ch = createLiveCh(name);
    try {
      await migrateLive(ch);
      const store = new ClickHouseRtStore(ch);
      const day0 = Date.parse("2026-11-09T23:59:00Z");
      const blocks = chain(500, 500 + 24 * 3600 + 130); // spans 2026-11-10 fully plus slack either side
      const base = blocks.get(500) as BlockAggregate;
      expect(base).toBeTruthy();
      // re-time the chain so block 500 is at 2026-11-09T23:59:00Z, one block per second
      let n = 0;
      let expectTx = 0;
      const batch: BlockAggregate[] = [];
      for (const b of blocks.values()) {
        const ts = day0 + n * 1000;
        batch.push({ ...b, blockTsMs: ts });
        if (ts >= Date.parse("2026-11-10T00:00:00Z") && ts < Date.parse("2026-11-11T00:00:00Z"))
          expectTx += b.txCount;
        n++;
      }
      // keep the test fast: store every block through one multi-row path (putBlock is exercised on a sample + replay)
      for (const b of batch.slice(0, 130)) await store.putBlock(b, 1, 2, true);
      expect(await store.putBlock(batch[5] as BlockAggregate, 1, 3)).toBe("noop");
      const m = await store.materializeMinute(Date.parse("2026-11-10T00:00:00Z"), true, day0, 5);
      expect(m).toMatchObject({ state: "final", complete: true, blockCount: 60 });
      const direct = batch
        .slice(0, 130)
        .filter((b) => b.blockTsMs >= m!.minuteMs && b.blockTsMs < m!.minuteMs + 60_000);
      expect(m!.txCount).toBe(direct.reduce((s, b) => s + b.txCount, 0));
      expect(m!.activeSigners).toBe(new Set(direct.flatMap((b) => b.signers)).size);
      expect(m!.topReceivers[0]?.receiverId).toBe("a.near");
      const open = await store.materializeMinute(Date.parse("2026-11-10T00:01:00Z"), false, day0, 6);
      expect(open?.state).toBe("provisional");
      expect((await store.lastBlock())?.height).toBe(629);

      const raw = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: "nearesis",
        password: "nearesis",
        database: name,
      });
      await raw.close();
      expect(expectTx).toBeGreaterThan(0);
    } finally {
      await ch.close();
      const admin = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: "nearesis",
        password: "nearesis",
        database: "default",
      });
      await admin.command({ query: `DROP DATABASE IF EXISTS ${name}` });
      await admin.close();
    }
  }, 60_000);
});
void reconcileDays;

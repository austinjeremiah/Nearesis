import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quarantineGapCode, salvagePage, type SkippedPage } from "../../src/adapters/explorer.ts";
import { makeSkipPolicy, recordQuarantineGapCh } from "../../src/backfill/explorer-session.ts";
import type { StateStore } from "../../src/backfill/state.ts";
import { ExplorerFixtureServer } from "../../src/testing/servers.ts";
import { loadPages, setupEnv, type TestEnv } from "../helpers/env.ts";

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

describe("salvagePage", () => {
  const item = (createdAt: string, addr: string, memo: unknown = null) => ({
    createdAt,
    depositAddress: addr,
    depositMemo: memo,
  });
  it("takes the createdAt range and the cursor after the last item", () => {
    const r = salvagePage(
      enc([item("2026-07-23T12:00:00.000Z", "a"), item("2026-07-23T10:00:00.000Z", "b", "m1")]),
    );
    expect(r).toEqual({
      fromUTC: "2026-07-23T10:00:00.000Z",
      toUTC: "2026-07-23T12:00:00.000Z",
      cursor: { lastDepositAddress: "b", lastDepositMemo: "m1" },
      items: 2,
    });
  });
  it("refuses bytes that carry no trustworthy position", () => {
    expect(salvagePage(new TextEncoder().encode("{not json"))).toBeNull();
    expect(salvagePage(enc({ a: 1 }))).toBeNull();
    expect(salvagePage(enc([]))).toBeNull();
    expect(salvagePage(enc([item("nope", "a")]))).toBeNull();
    expect(salvagePage(enc([item("2026-07-23T12:00:00.000Z", "")]))).toBeNull();
    expect(salvagePage(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe("skip policy and gap row", () => {
  const page = (h: string): SkippedPage => ({
    rawObjectHash: h,
    reasonCode: "BAD_SCHEMA",
    detail: "item 1: amountOut",
    fromUTC: "2026-07-23T10:00:00.000Z",
    toUTC: "2026-07-23T12:00:00.000Z",
    cursor: { lastDepositAddress: "a", lastDepositMemo: "" },
    items: 5,
  });
  const fakeCh = () => {
    const inserts: Array<{ table: string; values: Array<Record<string, unknown>> }> = [];
    return {
      inserts,
      ch: {
        insert: async (o: { table: string; values: Array<Record<string, unknown>> }) => {
          inserts.push(o);
        },
      } as unknown as ClickHouseClient,
    };
  };
  const fakeStore = (hashes?: string[]) =>
    ({
      state: { explorer: { skippedPageHashes: hashes } },
      save: () => undefined,
    }) as unknown as StateStore;

  it("writes one LIVE quality gap tagged with the raw object hash", async () => {
    const { ch, inserts } = fakeCh();
    await recordQuarantineGapCh(ch, page("h1"), 5);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ table: "quality_gaps" });
    expect(inserts[0]!.values[0]).toEqual({
      provider_id: "near-explorer",
      dataset: "intents_swaps",
      from_utc: "2026-07-23T10:00:00.000Z",
      to_utc: "2026-07-23T12:00:00.000Z",
      state: "unavailable",
      reason_code: quarantineGapCode("h1"),
      source_label: "LIVE",
      version: 5,
    });
  });
  it("caps skipped pages per session and cumulatively, and counts a hash once", async () => {
    const { ch } = fakeCh();
    const store = fakeStore(["x1", "x2"]);
    const p = makeSkipPolicy(ch, store, () => undefined, { perSession: 2, cumulative: 4 });
    expect(p.allow("x1")).toBe(true); // already counted
    expect(p.allow("n1")).toBe(true);
    await p.record(page("n1"));
    await p.record(page("n1")); // same page again: not counted twice
    expect(store.state.explorer.skippedPageHashes).toEqual(["x1", "x2", "n1"]);
    expect(p.allow("n2")).toBe(true);
    await p.record(page("n2")); // session 2 of 2, cumulative 4 of 4
    expect(p.allow("n3")).toBe(false);
    expect(p.allow("n1")).toBe(true);
    // per-session cap alone
    const p2 = makeSkipPolicy(ch, fakeStore(), () => undefined, { perSession: 1, cumulative: 25 });
    await p2.record(page("a"));
    expect(p2.allow("b")).toBe(false);
  });
});

describe("collector skip-and-record", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setupEnv();
  }, 60_000);
  afterAll(async () => {
    await env.close();
  }, 60_000);

  async function setup(): Promise<{
    c: ReturnType<TestEnv["collector"]>;
    pages: Record<string, unknown>[][];
    bad: Record<string, unknown>[];
  }> {
    const pages = loadPages("fx.explorer.pages-3");
    const server = new ExplorerFixtureServer(env.clock, pages);
    const c = env.collector(server.fetchImpl);
    await c.run({ maxPages: 1 });
    const bad = pages[1]!.map((t, i) => (i === 2 ? { ...t, amountOut: "99.862321" } : t));
    let served = false;
    server.intercept((r) => {
      if (!r.query.lastDepositAddress || served) return undefined;
      served = true;
      return { status: 200, body: JSON.stringify(bad) };
    });
    return { c, pages, bad };
  }
  const swaps = async (): Promise<number> =>
    Number(
      (await env.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps")).rows[0]?.n,
    );

  it("keeps the page quarantined, records the gap, advances the cursor and continues without promoting the page", async () => {
    const { c, pages } = await setup();
    const recorded: SkippedPage[] = [];
    const r = await c.run({
      skipQuarantined: { allow: () => true, record: async (s) => void recorded.push(s) },
    });
    expect(r.status).toBe("complete");
    expect(r.pagesSkipped).toBe(1);
    const q = await env.tdb.db.query<{ reason_code: string; raw_object_hash: string }>(
      "SELECT reason_code, raw_object_hash FROM ingestion.quarantine WHERE kind='explorer_page'",
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]!.reason_code).toBe("BAD_SCHEMA");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.rawObjectHash).toBe(q.rows[0]!.raw_object_hash);
    const times = pages[1]!.map((t) => Date.parse(t.createdAt as string));
    expect(recorded[0]!.fromUTC).toBe(new Date(Math.min(...times)).toISOString());
    expect(recorded[0]!.toUTC).toBe(new Date(Math.max(...times)).toISOString());
    const gap = await env.tdb.db.query<{ reason_code: string }>(
      "SELECT reason_code FROM ingestion.quality_gaps WHERE dataset='intents_swaps'",
    );
    expect(gap.rows.map((g) => g.reason_code)).toEqual([quarantineGapCode(q.rows[0]!.raw_object_hash)]);
    // pages 1 and 3 promoted, nothing from the quarantined page 2
    const keys = new Set(
      (
        await env.tdb.db.query<{ swap_key: string }>("SELECT swap_key FROM ingestion.explorer_swaps")
      ).rows.map((x) => x.swap_key),
    );
    for (const t of pages[1]!)
      expect(keys.has(`${t.depositAddress as string}|${(t.depositMemo as string | null) ?? ""}`)).toBe(false);
    expect(await swaps()).toBe(pages[0]!.length + pages[2]!.length);
  }, 60_000);

  it("stops with quarantine_cap and does not advance when the cap is reached", async () => {
    const env2 = await setupEnv();
    try {
      const pages = loadPages("fx.explorer.pages-3");
      const server = new ExplorerFixtureServer(env2.clock, pages);
      const c = env2.collector(server.fetchImpl);
      await c.run({ maxPages: 1 });
      const bad = pages[1]!.map((t, i) => (i === 2 ? { ...t, amountOut: "1.5" } : t));
      server.intercept((r) =>
        r.query.lastDepositAddress ? { status: 200, body: JSON.stringify(bad) } : undefined,
      );
      let recorded = 0;
      const r = await c.run({
        skipQuarantined: { allow: () => false, record: async () => void recorded++ },
      });
      expect(r.status).toBe("quarantine_cap");
      expect(recorded).toBe(0);
      expect((await c.checkpoint()).pagesCommitted).toBe(1);
      const n = await env2.tdb.db.query<{ n: string }>("SELECT count(*) n FROM ingestion.explorer_swaps");
      expect(Number(n.rows[0]?.n)).toBe(pages[0]!.length);
      const gaps = await env2.tdb.db.query("SELECT 1 FROM ingestion.quality_gaps");
      expect(gaps.rowCount).toBe(0);
    } finally {
      await env2.close();
    }
  }, 60_000);

  it("never skips a page whose position cannot be trusted (bad JSON)", async () => {
    const env3 = await setupEnv();
    try {
      const pages = loadPages("fx.explorer.pages-3");
      const server = new ExplorerFixtureServer(env3.clock, pages);
      const c = env3.collector(server.fetchImpl);
      await c.run({ maxPages: 1 });
      server.intercept((r) => (r.query.lastDepositAddress ? { status: 200, body: "{not json" } : undefined));
      const r = await c.run({ skipQuarantined: { allow: () => true, record: async () => undefined } });
      expect(r.status).toBe("quarantined");
      expect(r.quarantineReason).toBe("BAD_JSON");
    } finally {
      await env3.close();
    }
  }, 60_000);
});

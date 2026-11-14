import { describe, expect, it } from "vitest";
import type { WatermarkEvent } from "@nearesis/contracts";
import { MonitorFeeder, type FeederDeps, type WatermarkRow } from "../src/monitor-feeder.ts";

const row = (providerId: string, t: string | null, version: number, state = "fresh"): WatermarkRow => ({
  providerId,
  newestEventTime: t,
  state,
  version,
});

const NOW = Date.parse("2026-11-11T07:00:00Z");
function rig(rows: WatermarkRow[], values: Record<string, number | null>, failEnqueue = 0) {
  const events: WatermarkEvent[] = [];
  const seen = new Set<string>();
  let fails = failEnqueue;
  let valueCalls = 0;
  const deps: FeederDeps = {
    now: () => NOW,
    readWatermarks: async (after) => rows.filter((r) => r.version > after),
    metricIdsFor: (p) =>
      p === "near-explorer" ? ["live.swaps", "live.volume", "live.unobserved"] : ["live.other"],
    metricValue: async (id) => {
      valueCalls++;
      return values[id] ?? null;
    },
    enqueue: async (e) => {
      if (fails-- > 0) throw new Error("db down");
      const k = `${e.sourceId}|${e.watermark}|${e.mode}`;
      if (seen.has(k)) return { enqueued: false };
      seen.add(k);
      events.push(e);
      return { enqueued: true };
    },
  };
  return { feeder: new MonitorFeeder(deps), events, rows, calls: () => valueCalls };
}

describe("MonitorFeeder", () => {
  it("turns a new watermark row into one live event carrying gateway values; a missing value stays missing, never 0", async () => {
    const r = rig([row("near-explorer", "2026-11-11 06:29:35.944", 10)], {
      "live.swaps": 120,
      "live.volume": 0,
    });
    const pass = await r.feeder.pollOnce();
    expect(r.events).toEqual([
      {
        sourceId: "near-explorer",
        watermark: "2026-11-11T06:29:35.944Z",
        mode: "live",
        values: { "live.swaps": 120, "live.volume": 0 },
        maturity: "provisional", // an intraday watermark of the current day
      },
    ]);
    expect("live.unobserved" in r.events[0]!.values).toBe(false);
    expect(pass.enqueued[0]!.missing).toEqual(["live.unobserved"]);
    expect(r.feeder.cursorVersion).toBe(10);
  });

  it("marks a fresh watermark of a finished UTC day final and everything else provisional", async () => {
    const r = rig(
      [
        row("near-bigquery", "2026-11-10 00:00:00.000", 1),
        row("near-bigquery", "2026-11-09 00:00:00.000", 2, "late"),
        row("near-explorer", "2026-11-11 06:00:00.000", 3),
      ],
      { "live.other": 4, "live.swaps": 1 },
    );
    await r.feeder.pollOnce();
    expect(r.events.map((e) => [e.sourceId, e.maturity])).toEqual([
      ["near-bigquery", "final"],
      ["near-bigquery", "provisional"],
      ["near-explorer", "provisional"],
    ]);
  });

  it("a provider without data produces no event (no watermark is not a zero)", async () => {
    const r = rig([row("near-explorer", null, 5, "unavailable")], {});
    const pass = await r.feeder.pollOnce();
    expect(r.events).toHaveLength(0);
    expect(pass.skippedNoWatermark).toBe(1);
  });

  it("repeated rows with an unchanged watermark are processed once and later polls read nothing new", async () => {
    const r = rig(
      [
        row("near-explorer", "2026-11-11 06:00:00.000", 1),
        row("near-explorer", "2026-11-11 06:00:00.000", 2),
        row("near-explorer", "2026-11-11 06:00:00.000", 3),
      ],
      { "live.swaps": 5 },
    );
    await r.feeder.pollOnce();
    await r.feeder.pollOnce();
    expect(r.events).toHaveLength(1);
    expect(r.calls()).toBe(3); // three metrics, once
    r.rows.push(row("near-explorer", "2026-11-11 07:00:00.000", 4));
    await r.feeder.pollOnce();
    expect(r.events.map((e) => e.watermark)).toEqual([
      "2026-11-11T06:00:00.000Z",
      "2026-11-11T07:00:00.000Z",
    ]);
  });

  it("a restarted feeder re-reads from zero and the idempotent enqueue absorbs the duplicates", async () => {
    const rows = [row("near-explorer", "2026-11-11 06:00:00.000", 1)];
    const r = rig(rows, { "live.swaps": 1 });
    await r.feeder.pollOnce();
    const again = new MonitorFeeder({
      readWatermarks: async () => rows,
      metricIdsFor: () => ["live.swaps"],
      metricValue: async () => 1,
      enqueue: async (e) => ({ enqueued: !r.events.some((x) => x.watermark === e.watermark) }),
    });
    const pass = await again.pollOnce();
    expect(pass.failures).toBe(0);
    expect(r.events).toHaveLength(1);
  });

  it("a failed enqueue does not advance the cursor and is retried", async () => {
    const r = rig([row("near-explorer", "2026-11-11 06:00:00.000", 7)], { "live.swaps": 2 }, 1);
    const first = await r.feeder.pollOnce();
    expect(first.failures).toBe(1);
    expect(r.feeder.cursorVersion).toBe(0);
    expect(r.events).toHaveLength(0);
    await r.feeder.pollOnce();
    expect(r.events).toHaveLength(1);
    expect(r.feeder.cursorVersion).toBe(7);
  });

  it("never emits non-finite values", async () => {
    const r = rig([row("near-explorer", "2026-11-11 06:00:00.000", 1)], {
      "live.swaps": Number.NaN,
      "live.volume": Number.POSITIVE_INFINITY,
    });
    await r.feeder.pollOnce();
    expect(r.events[0]!.values).toEqual({});
  });
});

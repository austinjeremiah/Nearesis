import { describe, expect, it } from "vitest";
import type { WatermarkEvent } from "@nearesis/contracts";
import { MonitorFeeder } from "../../src/monitor-feeder.ts";
import type { FeederDeps, WatermarkRow } from "../../src/monitor-feeder.ts";
import { DegradationGuard } from "../../src/overload/index.ts";

const row = (t: string | null, version: number, state = "fresh"): WatermarkRow => ({
  providerId: "near-explorer",
  newestEventTime: t,
  state,
  version,
});

describe("MonitorFeeder with the degradation guard", () => {
  it("publishes nothing current while the provider is unavailable, then lets exactly one probe through after the interval", async () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    const rows: WatermarkRow[] = [row("2026-11-10 00:00:00.000", 1)]; // finished day, fresh: final
    const events: WatermarkEvent[] = [];
    const deps: FeederDeps = {
      now: () => now,
      readWatermarks: async (after) => rows.filter((r) => r.version > after),
      metricIdsFor: () => ["live.swaps"],
      metricValue: async () => 7,
      enqueue: async (e) => {
        events.push(e);
        return { enqueued: true };
      },
    };
    const guard = new DegradationGuard<Record<string, number>>({ openMs: 1000, now: () => now });
    const feeder = new MonitorFeeder({ ...deps, degradation: guard });

    // healthy: published, finalized values kept as the snapshot
    await feeder.pollOnce();
    expect(events).toHaveLength(1);
    expect(guard.isDegraded("near-explorer")).toBe(false);

    // the provider goes unavailable; new rows with a watermark arrive (stale data) and are not published as current
    rows.push(row(null, 2, "unavailable"), row("2026-11-11 00:00:00.000", 3, "late"));
    const blocked = await feeder.pollOnce();
    expect(blocked.blockedDegraded).toBe(1);
    expect(events).toHaveLength(1);
    expect(() => guard.assertCanPublishCurrent("near-explorer")).toThrow();
    // meanwhile the last finalized snapshot is what a reader gets, with a warning
    const shown = guard.lastFinalized("near-explorer")!;
    expect(shown.value).toEqual({ "live.swaps": 7 });
    expect(shown.serve.servedFrom).toBe("last_finalized_snapshot");
    expect(shown.serve.currentPublicationAllowed).toBe(false);
    expect(shown.serve.warning?.code).toBeDefined();

    // restored, but the interval has not passed: still no publication
    rows.push(row("2026-11-11 00:00:00.000", 4, "fresh"));
    expect((await feeder.pollOnce()).blockedDegraded).toBe(1);
    expect(events).toHaveLength(1);

    // after the interval, one probe is published and the provider is healthy again
    now += 1000;
    rows.push(row("2026-11-11 00:00:00.000", 5, "fresh"));
    const probe = await feeder.pollOnce();
    expect(probe.blockedDegraded).toBe(0);
    expect(events).toHaveLength(2);
    expect(guard.isDegraded("near-explorer")).toBe(false);
    expect(guard.breakerOf("near-explorer").probeCount).toBe(1);
  });

  it("a failed probe re-opens the breaker and publishes nothing", async () => {
    let now = Date.parse("2026-11-12T12:00:00Z");
    const rows: WatermarkRow[] = [row(null, 1, "unavailable"), row("2026-11-10 00:00:00.000", 2, "fresh")];
    const fail = true;
    const deps: FeederDeps = {
      now: () => now,
      readWatermarks: async (after) => rows.filter((r) => r.version > after),
      metricIdsFor: () => ["live.swaps"],
      metricValue: async () => 1,
      enqueue: async () => {
        if (fail) throw new Error("db down");
        return { enqueued: true };
      },
    };
    const guard = new DegradationGuard<Record<string, number>>({ openMs: 1000, now: () => now });
    const feeder = new MonitorFeeder({ ...deps, degradation: guard });
    await feeder.pollOnce(); // unavailable -> degraded; the fresh row is blocked (interval not passed)
    now += 1000;
    rows.push(row("2026-11-10 12:00:00.000", 3, "fresh"));
    const p = await feeder.pollOnce(); // the probe: enqueue fails
    expect(p.failures).toBe(1);
    expect(guard.isDegraded("near-explorer")).toBe(true);
    expect(guard.breakerOf("near-explorer").state).toBe("open");
  });
});

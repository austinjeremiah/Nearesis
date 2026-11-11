import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MonitorFeeder } from "../src/monitor-feeder.ts";
import { apiFixture } from "./helpers.ts";
import type { ApiFixture } from "./helpers.ts";

let f: ApiFixture;
beforeAll(async () => {
  f = await apiFixture();
});
afterAll(async () => f.close());

describe("MonitorFeeder against the real kernel scheduler inbox", () => {
  it("lands watermark events in source_watermark_events with the observed values only, idempotently", async () => {
    const scheduler = f.kernel.monitorScheduler();
    const rows = [
      { providerId: "near-bigquery", newestEventTime: "2026-11-10 00:00:00.000", state: "fresh", version: 1 },
      { providerId: "near-bigquery", newestEventTime: "2026-11-10 00:00:00.000", state: "fresh", version: 2 },
    ];
    const mk = () =>
      new MonitorFeeder({
        readWatermarks: async (after) => rows.filter((r) => r.version > after),
        metricIdsFor: () => ["live.near_tx_count", "live.contract_interactions"],
        metricValue: async (id) => (id === "live.near_tx_count" ? 970505 : null),
        enqueue: (e) => scheduler.enqueue(e),
        now: () => Date.parse("2026-11-11T07:00:00Z"),
      });
    await mk().pollOnce();
    await mk().pollOnce(); // a restarted feeder: the duplicate is absorbed by the unique key
    const r = await f.db.admin.query(
      "SELECT source_id, watermark, mode, values_json FROM source_watermark_events WHERE source_id = 'near-bigquery'",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].mode).toBe("live");
    expect(r.rows[0].values_json).toEqual({ "live.near_tx_count": 970505 }); // contract_interactions absent, not 0
  });
});

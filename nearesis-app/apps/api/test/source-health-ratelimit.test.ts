import { describe, expect, it } from "vitest";
import { assembleSourceHealth } from "../src/source-health.ts";

const wm = (id: string) => ({
  provider_id: id,
  newest_event_time: null,
  gap_count: 0,
  provider_lag_seconds: null,
  schema_version: null,
  state: "fresh",
});

describe("source rate limit", () => {
  it("fills from recorded history and is null with recorded:false otherwise (no fabricated zero)", () => {
    const [a, b] = assembleSourceHealth([wm("intents-1click"), wm("near-bigquery")], [], [], 90, [
      {
        provider_id: "intents-1click",
        attempts: "576",
        limited: "0",
        last_attempt: "2026-11-12 18:00:00.000",
      },
    ]);
    expect(a!.rateLimitRecorded).toBe(true);
    expect(a!.rateLimit).toMatchObject({ status: "not_limited", attempts: 576, limited: 0 });
    expect(a!.rateLimit!.lastAttemptAt).toBe("2026-11-12T18:00:00.000Z");
    expect(b!.rateLimit).toBeNull();
    expect(b!.rateLimitRecorded).toBe(false);
  });
  it("treats zero attempts as not recorded", () => {
    const [a] = assembleSourceHealth([wm("intents-1click")], [], [], 90, [
      { provider_id: "intents-1click", attempts: "0", limited: "0", last_attempt: null },
    ]);
    expect(a!.rateLimit).toBeNull();
    expect(a!.rateLimitRecorded).toBe(false);
  });
});

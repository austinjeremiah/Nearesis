import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settledVolumeProposal } from "../../../../services/analytics/src/intents/settled-volume-proposal.ts";
import { USD_IMPLAUSIBLE_THRESHOLD_USD as INGEST_THRESHOLD } from "../../../../services/ingestion/src/backfill/usd-quarantine.ts";
import { USD_IMPLAUSIBLE_THRESHOLD_USD } from "../../../../services/analytics/src/intents/settled-volume-proposal.ts";
import { dayOf, principal, setup, type Harness } from "./harness.ts";

let h: Harness;
const OWN = { ...principal("o", "human", "owner", "system"), workspaceId: "platform" };
const SVC = { ...principal("svc-a26", "service", null, "system"), workspaceId: "platform" };
beforeAll(async () => {
  h = await setup();
  // day 0: SUCCESS rows from the harness (10.5 + 20.25) plus: a REFUNDED row with an absurd value, a SUCCESS row above the
  // bound, a SUCCESS row with unknown USD. day 1: only an unknown-USD SUCCESS row replaces nothing (harness rows remain).
  const row = (key: string, day: string, status: string, usd: string | null) => ({
    swap_key: key,
    created_at: `${day} 11:00:00`,
    created_day: day,
    status,
    amount_in_usd: usd,
    fetched_at: `${day} 12:00:00`,
    version: 1,
  });
  await h.ins("intents_swaps", [
    row("x-refund", dayOf(0), "REFUNDED", "29988690000000"),
    row("x-implausible", dayOf(0), "SUCCESS", "2000000000"),
    row("x-unknown", dayOf(0), "SUCCESS", null),
    row("y-only-unknown", dayOf(50), "SUCCESS", null),
  ]);
  await h.ins("source_coverage", [
    {
      provider_id: "near-explorer",
      dataset: "intents_swaps",
      day: dayOf(50),
      state: "complete",
      reason: null,
      source_label: "FIXTURE",
      version: 1,
    },
  ]);
});
afterAll(async () => h.close());

describe("intents.settled_volume_usd_known (F3)", () => {
  it("the proposal's bound equals the ingestion quarantine rule's bound", () => {
    expect(USD_IMPLAUSIBLE_THRESHOLD_USD).toBe(INGEST_THRESHOLD);
  });
  it("validates and reconciles against raw through the governed pipeline, and stays unprivileged until a human certifies", async () => {
    const r = await h.svc.propose(
      SVC,
      settledVolumeProposal({ principalId: SVC.id, kind: "service", tenantId: "system" }),
    );
    expect(r.report?.issues).toEqual([]);
    expect(r.record.status).toBe("VALIDATED");
    expect(r.record.metricKey).toBe("intents.settled_volume_usd_known");
  });
  it("counts SUCCESS swaps within the bound only; refunded, implausible and unknown-USD swaps never add; an all-unknown day is NULL", async () => {
    const e = await h.svc.explore(
      OWN,
      { metricKey: "intents.settled_volume_usd_known", version: 1 },
      { from: dayOf(0), to: dayOf(2) },
    );
    // 10.5 + 20.25 only: the 29.99 trillion REFUNDED swap, the 2e9 SUCCESS swap and the unknown one are excluded
    expect(Number(e.envelope.rows[0]![1])).toBeCloseTo(30.75, 6);
    const unknownDay = await h.svc.explore(
      OWN,
      { metricKey: "intents.settled_volume_usd_known", version: 1 },
      { from: dayOf(50), to: dayOf(51) },
    );
    expect(unknownDay.envelope.rows.every((r) => r[1] === null)).toBe(true);
  });
});

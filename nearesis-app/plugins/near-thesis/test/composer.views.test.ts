/**
 * A semantic query is limited to ONE view. When the model plans a panel whose measures span views (for example transactions
 * and Intents swaps), the composer splits it into one panel per view instead of sending an INCOMPATIBLE_VIEWS query.
 */
import { describe, expect, it } from "vitest";
import type { InferenceProvider, StructuredResult } from "@nearesis/contracts";
import type { z } from "zod";
import { composeCanvas } from "../src/index.ts";

const CATALOGUE = {
  ok: true,
  semanticVersion: "1.0.0",
  metrics: [
    { id: "live.near_tx_count", cubeMember: "near_daily_tx_live.tx_count", unit: "tx", visibility: "public" },
    {
      id: "live.oneclick_swap_count",
      cubeMember: "intents_swaps_live.swap_count",
      unit: "swaps",
      visibility: "public",
    },
  ],
  dimensions: [{ id: "near_daily_tx_live.day" }, { id: "intents_swaps_live.day" }],
};
const GUARDED = Symbol.for("nearesis.guardedInference");
const W = { from: "2026-05-01T00:00:00Z", to: "2026-11-10T00:00:00Z" };
const provider = (plan: unknown) =>
  ({
    id: "mock",
    generateStructured: async <T>(a: { schema: z.ZodType<T> }): Promise<StructuredResult<T>> =>
      ({
        output: a.schema.parse(plan),
        provider: "mock",
        model: "m",
        requestId: "r",
        usage: { inputTokens: 0, outputTokens: 0 },
        evidence: null,
        rawResponseSha256: "0".repeat(64),
      }) as StructuredResult<T>,
    [GUARDED]: true,
  }) as unknown as InferenceProvider;

describe("composer: one view per panel", () => {
  it("splits a plan panel that spans two views into one panel per view; same-view panels are untouched", async () => {
    let sent: Array<{ title: string; query: { measures: string[]; time: { field: string } } }> = [];
    const invoke = async (cap: string, input: unknown) => {
      if (cap === "semantic.discover@1") return CATALOGUE;
      sent = (input as { requests: typeof sent }).requests;
      return {
        ok: true,
        patch: { schemaVersion: 1, type: "workspace.patch", operations: [{ op: "addPanel", panel: {} }] },
        issues: [],
      };
    };
    const res = await composeCanvas({
      prompt: "tx vs swaps",
      provider: provider({
        rationale: "r",
        panels: [
          {
            title: "Transactions vs swaps",
            mark: "line",
            measures: ["live.near_tx_count", "live.oneclick_swap_count"],
            grain: "day",
            ...W,
          },
          { title: "Swaps", mark: "bar", measures: ["live.oneclick_swap_count"], grain: "week", ...W },
        ],
      }),
      model: "m",
      invoke,
      expectedRevision: 0,
      idempotencyKey: "k:compose",
    });
    expect(res.status).toBe("ok");
    expect(sent.map((r) => [r.query.time.field, r.query.measures])).toEqual([
      ["near_daily_tx_live.day", ["live.near_tx_count"]],
      ["intents_swaps_live.day", ["live.oneclick_swap_count"]],
      ["intents_swaps_live.day", ["live.oneclick_swap_count"]],
    ]);
    expect(sent[0]!.title).toContain("near daily tx");
    expect(new Set(sent.map((r) => (r as unknown as { panelId: string }).panelId)).size).toBe(3);
  });
});

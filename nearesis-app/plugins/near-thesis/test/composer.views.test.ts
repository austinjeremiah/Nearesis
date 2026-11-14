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

describe("composer: plans that the gateway or compiler would refuse are shaped, not sent", () => {
  const CAT = {
    ok: true,
    semanticVersion: "1.0.0",
    metrics: [
      {
        id: "live.near_tx_count",
        cubeMember: "near_daily_tx_live.tx_count",
        unit: "tx",
        aggregationLaw: "sum",
        grain: "day",
        visibility: "public",
      },
      {
        id: "live.near_signers",
        cubeMember: "near_daily_tx_live.signers",
        unit: "signers",
        aggregationLaw: "count_distinct",
        grain: "day",
        visibility: "public",
      },
      {
        id: "live.near_distinct_signer_proxy",
        cubeMember: "near_daily_tx_live.distinct_signer_proxy",
        unit: "tx",
        aggregationLaw: "non_additive",
        grain: "day",
        visibility: "public",
      },
    ],
    dimensions: [{ id: "near_daily_tx_live.day" }],
  };
  type Req = {
    title: string;
    query: { measures: string[]; time: { from: string; to: string; grain: string } };
  };
  const run = async (panels: unknown[], preview: (reqs: Req[]) => unknown) => {
    const seen: Req[][] = [];
    const invoke = async (cap: string, input: unknown) => {
      if (cap === "semantic.discover@1") return CAT;
      const reqs = (input as { requests: Req[] }).requests;
      seen.push(structuredClone(reqs));
      return preview(reqs);
    };
    const res = await composeCanvas({
      prompt: "q",
      provider: provider({ rationale: "r", panels }),
      model: "m",
      invoke,
      expectedRevision: 0,
      idempotencyKey: "k:compose",
    });
    return { res, seen };
  };
  const okPatch = {
    ok: true,
    patch: { schemaVersion: 1, type: "workspace.patch", operations: [{ op: "addPanel", panel: {} }] },
    issues: [],
  };

  it("measures with different units get their own panel (no UNIT_MISMATCH)", async () => {
    const { res, seen } = await run(
      [
        {
          title: "Activity",
          mark: "line",
          measures: ["live.near_tx_count", "live.near_signers"],
          grain: "day",
          ...W,
        },
      ],
      () => okPatch,
    );
    expect(res.status).toBe("ok");
    expect(seen[0]!.map((r) => [r.title, r.query.measures])).toEqual([
      ["Activity [tx]", ["live.near_tx_count"]],
      ["Activity [signers]", ["live.near_signers"]],
    ]);
  });

  it("a distinct count or ratio planned at week grain is queried at day grain; additive measures keep the week", async () => {
    const { res, seen } = await run(
      [
        {
          title: "Weekly",
          mark: "bar",
          measures: ["live.near_tx_count", "live.near_distinct_signer_proxy"],
          grain: "week",
          ...W,
        },
      ],
      () => okPatch,
    );
    expect(res.status).toBe("ok");
    expect(seen[0]!.map((r) => [r.title, r.query.measures, r.query.time.grain])).toEqual([
      ["Weekly", ["live.near_tx_count"], "week"],
      ["Weekly (daily)", ["live.near_distinct_signer_proxy"], "day"],
    ]);
  });

  it("a COST_CAP refusal narrows the window to the share the cap allows and repeats the preview once; the cap is untouched", async () => {
    const wide = { from: "2026-01-01T00:00:00Z", to: "2026-11-01T00:00:00Z" }; // 304 days
    const { res, seen } = await run(
      [{ title: "Swaps", mark: "line", measures: ["live.near_tx_count"], grain: "day", ...wide }],
      (reqs) => {
        const days = Math.round(
          (Date.parse(reqs[0]!.query.time.to) - Date.parse(reqs[0]!.query.time.from)) / 86_400_000,
        );
        const est = days * 20_000; // 20k rows per day against the 5M cap
        return est > 5_000_000
          ? {
              ok: false,
              patch: null,
              issues: [
                { index: 0, code: "COST_CAP", message: `Estimated ${est} rows exceeds the cap of 5000000.` },
              ],
            }
          : okPatch;
      },
    );
    expect(res.status).toBe("ok");
    expect(seen).toHaveLength(2);
    const narrowed = seen[1]![0]!;
    expect(Date.parse(narrowed.query.time.to)).toBe(Date.parse("2026-11-01T00:00:00Z"));
    const keptDays = (Date.parse(narrowed.query.time.to) - Date.parse(narrowed.query.time.from)) / 86_400_000;
    expect(keptDays).toBeLessThan(250); // 5M / 20k = 250 days, minus the safety margin
    expect(keptDays).toBeGreaterThan(200);
    expect(narrowed.title).toMatch(/^Swaps \(last \d+ days\)$/);
  });

  it("any other refusal is returned unchanged and never retried", async () => {
    const { res, seen } = await run(
      [{ title: "Swaps", mark: "line", measures: ["live.near_tx_count"], grain: "day", ...W }],
      () => ({ ok: false, patch: null, issues: [{ index: 0, code: "INCOMPATIBLE_VIEWS", message: "x" }] }),
    );
    expect(res.status).toBe("rejected");
    expect(res.issues[0]!.code).toBe("INCOMPATIBLE_VIEWS");
    expect(seen).toHaveLength(1);
  });
});

import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { baseline, cov } from "@nearesis/analytics";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

const data = baseline();
// Day 5 of the swaps dataset is only partially scanned (a partial partition); everything else is complete.
data.tables.source_coverage = data.tables.source_coverage.map((c) =>
  c.dataset === "intents_swaps" && c.day === "2026-10-05"
    ? cov("intents-1click", "intents_swaps", "2026-10-05", "partial", "PARTITION_PARTIAL")
    : c,
);
data.tables.watermarks = data.tables.watermarks.map((w) =>
  w.providerId === "intents-1click" ? { ...w, state: "partial" as const, gapCount: 1 } : w,
);
data.tables.quality_gaps.push({
  providerId: "intents-1click",
  dataset: "intents_swaps",
  fromUTC: "2026-10-05T12:00:00.000Z",
  toUTC: "2026-10-06T00:00:00.000Z",
  state: "partial",
  reasonCode: "PARTITION_PARTIAL",
  sourceLabel: "SYNTHETIC",
});

let env: Env;
beforeAll(async () => {
  env = await setupEnv(data);
});
afterAll(async () => env.close());

test("S08 a partial partition is reported partial, never fresh or complete", async () => {
  const gw = env.gateway();
  const q = ast({ measures: ["intents.oneclick_completed_swap_count"] });
  const r = await gw.query(W1, q);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const e = r.envelope;
  const i5 = e.rows.findIndex((x) => String(x[0]).startsWith("2026-10-05"));
  expect(e.rowCoverage![i5]).toBe("partial");
  expect(e.rowCoverage!.filter((c) => c === "partial")).toHaveLength(1);
  expect(e.rowCoverage!.filter((c) => c === "complete")).toHaveLength(9);
  expect(e.partialCount).toBe(1);
  expect(e.certification).toBe("partial");
  expect(e.certification).not.toBe("certified");
  expect(e.gaps.some((g) => g.reason === "PARTITION_PARTIAL")).toBe(true);
  expect(e.rows[i5]![1]).not.toBeNull(); // the partial day keeps its observed value, flagged
  // a cached repeat still says partial
  const again = await gw.query(W1, q);
  expect(again.ok && again.cache).toBe("hit");
  expect(again.ok && again.envelope.certification).toBe("partial");
  // a window that avoids the partial day is complete
  const clean = await gw.query(
    W1,
    ast({
      measures: ["intents.oneclick_completed_swap_count"],
      time: { field: "intents.day", from: "2026-10-06T00:00:00Z", to: "2026-10-11T00:00:00Z", grain: "day" },
    }),
  );
  expect(clean.ok && clean.envelope.certification).toBe("certified");
  observe({
    testId: "S08",
    observed:
      "partial swap day 2026-10-05: rowCoverage=partial, partialCount=1, certification=partial (not certified), gap reason PARTITION_PARTIAL listed, value retained and flagged; cached repeat still partial; a window excluding the day is certified",
    fixtureHash: data.digest,
    evidence: {
      rowCoverage: e.rowCoverage,
      partialCount: e.partialCount,
      certification: e.certification,
      gaps: e.gaps,
      watermarks: e.sourceWatermarks,
    },
  });
});

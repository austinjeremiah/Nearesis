import { afterAll, beforeAll, expect, test } from "vitest";
import { observe } from "@nearesis/acceptance";
import { zeroVsGap } from "@nearesis/analytics";
import { DEFAULT_POLICY } from "../../src/index.ts";
import { ast, setupEnv, W1, type Env } from "../helpers.ts";

let env: Env;
beforeAll(async () => {
  env = await setupEnv(zeroVsGap());
});
afterAll(async () => env.close());

const M = "intents.oneclick_completed_swap_count";

test("S11 confirmed zero vs gap vs partial", async () => {
  const gw = env.gateway();
  const r = await gw.query(W1, ast({ measures: [M] }));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const e = r.envelope;
  const row = (d: number) =>
    e.rows.findIndex((x) => String(x[0]).startsWith(`2026-10-${String(d).padStart(2, "0")}`));
  const i3 = row(3),
    i6 = row(6),
    i9 = row(9);
  expect(e.rows).toHaveLength(10);
  expect(e.rows[i3]![1]).toBe(0);
  expect(e.rowCoverage![i3]).toBe("complete");
  expect(e.rows[i6]![1]).toBeNull();
  expect(e.rowCoverage![i6]).toBe("unavailable");
  expect(
    e.gaps.some((g) => g.from === "2026-10-06T00:00:00.000Z" && g.to === "2026-10-07T00:00:00.000Z"),
  ).toBe(true);
  expect(e.rows[i9]![1]).toBe(2);
  expect(e.rowCoverage![i9]).toBe("partial");
  expect(e.nullCount).toBe(1);
  expect(e.partialCount).toBe(1);
  expect(e.certification).not.toBe("certified");
  expect(e.rows.filter((_, i) => ![i3, i6, i9].includes(i)).every((x) => x[1] === 3)).toBe(true);

  // (e) window aggregate: flagged partial with excluded days (policy partial) ...
  const month = await gw.query(
    W1,
    ast({
      measures: [M],
      time: {
        field: "intents.day",
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-11T00:00:00Z",
        grain: "month",
      },
    }),
  );
  expect(month.ok).toBe(true);
  if (!month.ok) return;
  expect(month.envelope.rows).toHaveLength(1);
  expect(month.envelope.rowCoverage).toEqual(["partial"]);
  expect(month.envelope.certification).toBe("partial");
  expect(month.envelope.rows[0]![1]).toBe(23);
  expect(month.envelope.gaps.map((g) => g.from.slice(0, 10))).toContain("2026-10-06");
  // ... or refused by a strict policy.
  const strict = env.gateway({ policy: () => ({ ...DEFAULT_POLICY, incompleteWindow: "refuse" }) });
  const refused = await strict.query(
    W1,
    ast({
      measures: [M],
      time: {
        field: "intents.day",
        from: "2026-10-01T00:00:00Z",
        to: "2026-10-11T00:00:00Z",
        grain: "month",
      },
    }),
  );
  expect(refused.ok).toBe(false);
  expect(!refused.ok && refused.error.reasonCode).toBe("INCOMPLETE_WINDOW");
  expect(strict.stats().executions).toBe(0);
  observe({
    testId: "S11",
    observed:
      "day3=0 (complete); day6=null (unavailable, in gap list 2026-10-06..07); day9=2 (partial); nullCount=1 partialCount=1 certification=partial; month aggregate returned 23 flagged partial with excluded day 2026-10-06; strict policy refuses it with INCOMPLETE_WINDOW (0 executions)",
    fixtureHash: zeroVsGap().digest,
    evidence: {
      envelope: e,
      monthAggregate: month.envelope,
      strictRefusal: refused.ok ? null : refused.error,
    },
  });
});

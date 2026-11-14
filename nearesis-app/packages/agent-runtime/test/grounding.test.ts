import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { groundingScan } from "../src/index.ts";

const fx = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/numeric-grounding.json", import.meta.url)), "utf8"),
);

it("corpus: every unsupported-number case is flagged", () => {
  expect(fx.unsupported.length).toBeGreaterThanOrEqual(10);
  for (const t of fx.unsupported) {
    const r = groundingScan(t, fx.facts, { intervalBounds: fx.intervalBounds });
    expect(r.flagged.length, t).toBeGreaterThan(0);
  }
});
it("corpus: no incidental-token case is flagged", () => {
  expect(fx.incidental.length).toBeGreaterThanOrEqual(10);
  for (const t of fx.incidental) {
    const r = groundingScan(t, fx.facts, { intervalBounds: fx.intervalBounds });
    expect(
      r.flagged.map((f) => f.token),
      t,
    ).toEqual([]);
  }
});
it("supported numbers match within printed precision", () => {
  for (const t of fx.supported) {
    const r = groundingScan(t, fx.facts, { intervalBounds: fx.intervalBounds });
    expect(
      r.flagged.map((f) => f.token),
      t,
    ).toEqual([]);
  }
});
it("a textual date that is not an interval bound is flagged", () => {
  const r = groundingScan("It ended on November 9, 2026.", [], { intervalBounds: ["2026-11-07"] });
  expect(r.flagged.length).toBeGreaterThan(0);
});

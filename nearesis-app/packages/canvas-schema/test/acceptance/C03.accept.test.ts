/**
 * C03 — Chart unit mismatch. PASS: compiler labels/indexes or refuses.
 * Runs the real panel compiler and validator against a SYNTHETIC result shape with count and USD measures.
 */
import { describe, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { compileVisualization, hashCanonical, validatePanelSpec, type VizRequest } from "../../src/index.ts";
import { CATALOG } from "../fixtures/catalog.ts";
import { panel, RESULT_SWAPS, SHA, uuid } from "../fixtures/build.ts";

const base: VizRequest = {
  panelId: uuid(1),
  title: "Swaps vs volume",
  mark: "line",
  query: { hash: SHA("a"), semanticVersion: "1.0.0", grain: "day" },
  result: {
    ...RESULT_SWAPS,
    fields: [
      ...RESULT_SWAPS.fields,
      { name: "prices.close_usd", unit: "usd_per_near", role: "measure", metricId: "prices.close_usd" },
    ],
  },
  x: "intents.day",
  y: ["intents.swap_count", "intents.volume_usd"],
  completeness: "complete",
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

describe("C03 unit mismatch", () => {
  it("refuses undeclared mismatches, indexes or discloses declared ones", () => {
    const results: Record<string, unknown> = {};

    const undeclared = compileVisualization(base, CATALOG);
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.issues.map((i) => i.code)).toContain("UNIT_MISMATCH");
    results.undeclared = undeclared.ok ? "compiled" : undeclared.issues.map((i) => i.code);

    const indexed = compileVisualization({ ...base, unitStrategy: "index_100" }, CATALOG);
    expect(indexed.ok).toBe(true);
    if (indexed.ok) {
      expect(indexed.value.panel.encoding.scale).toBe("index_100");
      expect(indexed.value.viz.transforms.map((t) => t.kind)).toEqual(["index_100"]);
      expect(indexed.value.viz.axes.every((a) => a.unit === "index_100")).toBe(true);
      results.indexed = {
        scale: indexed.value.panel.encoding.scale,
        label: indexed.value.viz.transforms[0]!.label,
      };
    }

    const dual = compileVisualization({ ...base, unitStrategy: "dual_axis_disclosed" }, CATALOG);
    expect(dual.ok).toBe(true);
    if (dual.ok) {
      const sides = dual.value.viz.axes.map((a) => `${a.side}:${a.unit}`);
      expect(sides).toEqual(["left:count", "right:usd"]);
      expect(dual.value.viz.transforms[0]!.label).toMatch(/left in count, right in usd/);
      results.dual = { axes: sides, label: dual.value.viz.transforms[0]!.label };
    }

    const three = compileVisualization(
      { ...base, y: [...base.y!, "prices.close_usd"], unitStrategy: "dual_axis" },
      CATALOG,
    );
    expect(three.ok).toBe(false);
    results.threeUnitsDual = three.ok ? "compiled" : three.issues.map((i) => i.code);

    // A stored/agent PanelSpec that bypasses the compiler is still checked by the validator.
    const rawThree = panel(3, {
      dataBinding: {
        fields: ["intents.day", "intents.swap_count", "intents.volume_usd", "prices.close_usd"],
        units: {
          "intents.swap_count": "count",
          "intents.volume_usd": "usd",
          "prices.close_usd": "usd_per_near",
        },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: {
        x: "intents.day",
        y: ["intents.swap_count", "intents.volume_usd", "prices.close_usd"],
        interpolateGaps: false,
      },
    });
    const v3 = validatePanelSpec(rawThree);
    expect(!v3.ok && v3.issues.some((i) => i.code === "UNIT_MISMATCH")).toBe(true);

    // A declared unit that contradicts the query result is refused.
    const wrongUnit = panel(4, {
      dataBinding: {
        fields: ["intents.day", "intents.volume_usd"],
        units: { "intents.volume_usd": "count" },
        timezone: "UTC",
        completeness: "complete",
      },
      encoding: { x: "intents.day", y: ["intents.volume_usd"], interpolateGaps: false },
    });
    const vw = validatePanelSpec(wrongUnit, { resolveQuery: () => base.result });
    expect(!vw.ok && vw.issues.some((i) => i.code === "UNIT_MISMATCH")).toBe(true);
    results.rawThreeUnits = v3.ok ? "accepted" : v3.issues.map((i) => i.code);
    results.declaredVsResultUnit = vw.ok ? "accepted" : vw.issues.map((i) => i.code);

    observe({
      testId: "C03",
      observed:
        "count+usd undeclared -> refused UNIT_MISMATCH; index_100 declared -> compiled with scale index_100 and visible index label; dual axis declared -> compiled with left:count/right:usd disclosure label; 3 units -> refused; raw 3-unit PanelSpec -> validator UNIT_MISMATCH; declared unit contradicting result unit -> UNIT_MISMATCH",
      fixtureHash: hashCanonical({ base, catalog: CATALOG }),
      evidence: results,
    });
  });
});

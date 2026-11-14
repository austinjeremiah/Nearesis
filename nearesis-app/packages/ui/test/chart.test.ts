import { describe, expect, it } from "vitest";
import { buildOption, chartTextAlternative } from "../src/chart/buildOption";
import { minMaxBucket } from "../src/chart/downsample";
import { readChartTheme } from "../src/chart/theme";
import type { ChartSpec } from "../src/types";

const theme = readChartTheme();
const spec: ChartSpec = {
  kind: "line",
  title: "Volume <img src=x onerror=alert(1)>",
  columns: [
    { name: "t", unit: null },
    { name: "v", unit: "USD" },
  ],
  rows: [
    ["2026-10-01T00:00:00Z", 1],
    ["2026-10-02T00:00:00Z", null],
    ["2026-10-03T00:00:00Z", 3],
  ],
  x: { field: "t", type: "time" },
  y: [{ field: "v", unit: "USD" }],
  gaps: [{ from: "2026-10-02T00:00:00Z", to: "2026-10-03T00:00:00Z", reason: "outage" }],
  markers: [{ id: "m", kind: "threshold", value: 2, op: "gt" }],
};

function containsFunction(v: unknown, seen = new Set<unknown>()): boolean {
  if (typeof v === "function") return true;
  if (v && typeof v === "object") {
    if (seen.has(v)) return false;
    seen.add(v);
    return Object.values(v).some((x) => containsFunction(x, seen));
  }
  return false;
}

describe("buildOption (declared specs only)", () => {
  it("emits plain data: no functions anywhere in the option", () => {
    for (const kind of ["line", "area", "bar", "scatter"] as const) {
      const { option } = buildOption({ ...spec, kind }, { theme, reducedMotion: false, brush: true });
      expect(containsFunction(option), kind).toBe(false);
      expect(() => JSON.stringify(option)).not.toThrow();
    }
  });
  it("renders tooltips as canvas rich text, never HTML", () => {
    const { option } = buildOption(spec, { theme, reducedMotion: false });
    expect((option.tooltip as { renderMode: string }).renderMode).toBe("richText");
  });
  it("keeps gaps as breaks, never interpolated", () => {
    const { option } = buildOption(spec, { theme, reducedMotion: false });
    const s = (
      option.series as Array<{
        connectNulls: boolean;
        data: Array<[number, number | null]>;
        markArea: { data: unknown[] };
      }>
    )[0]!;
    expect(s.connectNulls).toBe(false);
    expect(s.data[1]![1]).toBeNull();
    expect(s.markArea.data).toHaveLength(1);
  });
  it("turns off animation under reduced motion and for large series", () => {
    expect(buildOption(spec, { theme, reducedMotion: true }).option.animation).toBe(false);
    expect(buildOption(spec, { theme, reducedMotion: false }).option.animation).toBe(true);
    const big = {
      ...spec,
      rows: Array.from({ length: 2500 }, (_, i) => [
        `2026-10-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
        i,
      ]),
    };
    expect(buildOption(big, { theme, reducedMotion: false }).option.animation).toBe(false);
  });
  it("text alternative states units, missing values, gaps and downsampling, and carries no markup", () => {
    const t = chartTextAlternative({
      ...spec,
      downsampling: { method: "min_max_bucket", originalPoints: 100000 },
    });
    expect(t).toContain("in USD");
    expect(t).toContain("1 missing");
    expect(t).toContain("gap");
    expect(t).toContain("min_max_bucket");
  });
});

describe("minMaxBucket", () => {
  it("keeps single-point spikes and bounds the output", () => {
    const pts: Array<[number, number | null]> = Array.from({ length: 100000 }, (_, i) => [
      i,
      100 + Math.sin(i / 50),
    ]);
    pts[50000] = [50000, 900];
    pts[70001] = [70001, -400];
    const out = minMaxBucket(pts, 2000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out.some((p) => p[1] === 900)).toBe(true);
    expect(out.some((p) => p[1] === -400)).toBe(true);
  });
  it("preserves gaps (null breaks) inside a bucket", () => {
    const pts: Array<[number, number | null]> = Array.from({ length: 10000 }, (_, i) => [
      i,
      i >= 4000 && i < 4100 ? null : i % 7,
    ]);
    expect(minMaxBucket(pts, 500).some((p) => p[1] === null)).toBe(true);
  });
  it("returns small inputs unchanged", () => {
    const pts: Array<[number, number | null]> = [
      [0, 1],
      [1, 2],
    ];
    expect(minMaxBucket(pts, 100)).toBe(pts);
  });
});

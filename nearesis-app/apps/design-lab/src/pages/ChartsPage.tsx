import { Chart } from "@nearesis/ui";
import { candlestickSpec, chainBarSpec, fillLatencySpec, heatmapSpec, volumeSpec } from "../fixtures/data";

const SPECS = [
  { id: "area", spec: volumeSpec(), note: "Area + gap shading + threshold and range markers" },
  { id: "bar", spec: chainBarSpec(), note: "Bar, single hue" },
  { id: "dual", spec: fillLatencySpec(), note: "Line, dual axis, legend" },
  { id: "heatmap", spec: heatmapSpec(), note: "Heatmap, sequential single hue" },
  {
    id: "candle",
    spec: candlestickSpec(),
    note: "Candlestick, up and down paired with shape-independent hues",
  },
];

export function ChartsPage() {
  return (
    <main className="lab-page">
      <h1>Chart theme</h1>
      <p style={{ color: "var(--fg-muted)" }}>
        One option builder, token-driven colours, canvas renderer. SYNTHETIC data.
      </p>
      <div className="lab-grid" style={{ marginTop: 16 }}>
        {SPECS.map((s) => (
          <figure key={s.id} style={{ margin: 0 }} data-testid={`chart-cell-${s.id}`}>
            <div className="lab-cell lab-fixed" style={{ background: "var(--surface)" }}>
              <Chart spec={s.spec} testId={`chart-${s.id}`} />
            </div>
            <figcaption style={{ color: "var(--fg-subtle)", fontSize: "var(--text-xs)", marginTop: 6 }}>
              {s.note}
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}

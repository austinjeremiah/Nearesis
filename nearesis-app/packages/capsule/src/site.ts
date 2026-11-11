import type { CapsuleManifest } from "@nearesis/contracts";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SiteInput {
  manifestLike: Pick<
    CapsuleManifest,
    "title" | "label" | "claims" | "results" | "limitations" | "snapshot" | "computation"
  >;
  series: {
    x: { name: string; points: Array<[string, string]> };
    y: { name: string; points: Array<[string, string]> };
  };
  thesisLines: Array<{ claimId: string; claimClass: string; text: string; cites: string[] }>;
  rebuildCommand: string;
  dataLines: string[];
}

/** Indexed (first day = 100) integer-safe polyline. Floats are used only for pixel coordinates. */
function polyline(points: Array<[string, string]>, w: number, h: number, lo: number, hi: number): string {
  const first = Number(points[0]![1]) || 1;
  return points
    .map(([, v], i) => {
      const idx = (Number(v) / first) * 100;
      const px = (i / (points.length - 1)) * (w - 60) + 50;
      const py = h - 30 - ((idx - lo) / (hi - lo || 1)) * (h - 50);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

/** Self-contained accessible page: no scripts, no external requests, chart as inline SVG with a data table. */
export function renderSite(s: SiteInput): string {
  const m = s.manifestLike;
  const idx = (pts: Array<[string, string]>) =>
    pts.map(([, v]) => (Number(v) / (Number(pts[0]![1]) || 1)) * 100);
  const all = [...idx(s.series.x.points), ...idx(s.series.y.points)];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const W = 720;
  const H = 280;
  const days = s.series.x.points;
  const rows = days
    .map(
      ([d, v], i) =>
        `<tr><th scope="row">${esc(d)}</th><td>${esc(v)}</td><td>${esc(s.series.y.points[i]![1])}</td></tr>`,
    )
    .join("");
  const banner =
    m.label === "SYNTHETIC"
      ? `<p class="banner" role="note"><strong>SYNTHETIC DATA.</strong> This page describes a test fixture, not NEAR production activity.</p>`
      : "";
  const resultRows = m.results
    .map(
      (r) =>
        `<tr id="r-${esc(r.id)}"><th scope="row">${esc(r.label)}</th><td>${esc(r.value)}</td><td>${esc(r.unit ?? "")}</td><td>${esc(r.computation)}</td></tr>`,
    )
    .join("");
  const claims = s.thesisLines
    .map(
      (c) =>
        `<li><span class="tag">${esc(c.claimClass.replace(/_/g, " "))}</span> ${esc(c.text)} ${c.cites.map((x) => `<a href="#r-${esc(x)}">[${esc(x)}]</a>`).join(" ")}</li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<style>
:root{--bg:#fff;--fg:#14181f;--mut:#4a5565;--line:#c9d1dc;--accent:#0b5cad;--warn:#7a3e00;--warnbg:#fff4e0}
@media (prefers-color-scheme:dark){:root{--bg:#10151c;--fg:#e8edf4;--mut:#aab4c3;--line:#2c3643;--accent:#6db3ff;--warn:#ffd9a1;--warnbg:#3a2a10}}
body{margin:0 auto;max-width:56rem;padding:1rem 16px 3rem;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
h1,h2{line-height:1.2}a{color:var(--accent)}code,pre{font-family:ui-monospace,monospace;font-size:.9em}
pre{overflow-x:auto;padding:.75rem;border:1px solid var(--line)}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top}
.table-wrap{overflow-x:auto}
.banner{padding:.6rem .8rem;border:2px solid var(--warn);background:var(--warnbg);color:var(--warn)}
.tag{display:inline-block;border:1px solid var(--line);padding:0 .4rem;font-size:.8rem;color:var(--mut)}
.skip{position:absolute;left:-999px}.skip:focus{left:0}
svg{max-width:100%;height:auto}
</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
<h1>${esc(m.title)}</h1>
${banner}
<p>Evidence status: local recomputation only. This static page contains no scripts and makes no network requests.</p>
<h2 id="claims">Claims</h2>
<ul>${claims}</ul>
<h2 id="chart">Series (indexed, first day = 100)</h2>
<figure>
<svg role="img" aria-labelledby="ct cd" viewBox="0 0 ${W} ${H}">
<title id="ct">${esc(s.series.x.name)} and ${esc(s.series.y.name)}, indexed to 100 on the first day</title>
<desc id="cd">Two lines over ${days.length} consecutive days from ${esc(days[0]![0])} to ${esc(days[days.length - 1]![0])}. The data table below lists every value.</desc>
<rect width="${W}" height="${H}" fill="none"/>
<polyline fill="none" stroke="#0b5cad" stroke-width="2" points="${polyline(s.series.x.points, W, H, lo, hi)}"/>
<polyline fill="none" stroke="#c2410c" stroke-width="2" stroke-dasharray="6 3" points="${polyline(s.series.y.points, W, H, lo, hi)}"/>
<text x="50" y="14" font-size="12" fill="currentColor">solid: ${esc(s.series.x.name)}; dashed: ${esc(s.series.y.name)}</text>
</svg>
<figcaption>Solid line: ${esc(s.series.x.name)}. Dashed line: ${esc(s.series.y.name)}.</figcaption>
</figure>
<details><summary>Data table</summary>
<div class="table-wrap"><table><caption>Raw daily values</caption><thead><tr><th scope="col">Date</th><th scope="col">${esc(s.series.x.name)}</th><th scope="col">${esc(s.series.y.name)}</th></tr></thead><tbody>${rows}</tbody></table></div>
</details>
<h2 id="results">Computed results</h2>
<div class="table-wrap"><table><thead><tr><th scope="col">Result</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Computation</th></tr></thead><tbody>${resultRows}</tbody></table></div>
<h2 id="queries">Queries and computation</h2>
<pre>${esc(s.dataLines.join("\n"))}</pre>
<p>Rebuild offline from the frozen snapshot:</p>
<pre>${esc(s.rebuildCommand)}</pre>
<h2 id="limitations">Limitations</h2>
<ul>${m.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2 id="hashes">Hashes</h2>
<p>Raw data hash: <code>${esc(m.snapshot.dataHash)}</code><br>Verifier input: <code>${esc(m.computation.inputSha256)}</code><br>Results: <code>${esc(m.computation.resultsSha256)}</code></p>
</main>
</body>
</html>
`;
}

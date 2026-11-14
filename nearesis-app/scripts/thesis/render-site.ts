/** Offline single-file dashboard: inline CSS, inline SVG drawn here, no external requests. The only script toggles pointer visibility. */
import type { Chart } from "./charts.ts";
import { fmt } from "./ground.ts";
import type { Claim, Unable } from "./markdown.ts";

export interface ThesisJson {
  schema: "nearesis.thesis.v1";
  version: string;
  generatedAt: string;
  hypothesis: string;
  verdict: {
    status: string;
    headline: string;
    intentsVsPrice: {
      summary: string;
      rows: { label: string; value: string | null; unit: string | null; ref: string }[];
    };
    whatWouldChangeOurMind: string[];
  };
  sections: { id: string; title: string; markdown: string }[];
  claims: Claim[];
  charts: Chart[];
  tables: { name: string; system: string; purpose: string; columns: string[] }[];
  sampleQuery: { title: string; sql: string };
  unableToCompute: Unable[];
  reproduce: { command: string; check: string; hashes: { path: string; sha256: string }[] };
  files: { path: string; sha256: string; bytes: number }[];
}

export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** In table cells a run of citations collapses into one expandable chip so columns stay readable. */
function cellHtml(raw: string): string {
  const html = inline(raw);
  return html.replace(/(?:<span class="ref"[^>]*>[^<]*<\/span>\s*){2,}/g, (run) => {
    const n = (run.match(/class="ref"/g) ?? []).length;
    return `<details class="refs"><summary>${n} refs</summary>${run}</details>`;
  });
}

function inline(raw: string): string {
  return esc(raw)
    .replace(/\[([^[\]\s|]+#[^[\]\s|]+)\]/g, '<span class="ref" title="$1">[$1]</span>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function mdToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!;
    if (!l.trim()) {
      i++;
    } else if (l.trim().startsWith("|")) {
      const block: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) block.push(lines[i++]!);
      const cells = (x: string) =>
        x
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const head = cells(block[0]!);
      const body = block.slice(2).map(cells);
      out.push(
        `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
    } else if (l.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("- ")) items.push(lines[i++]!.slice(2));
      out.push(`<ul>${items.map((x) => `<li>${cellHtml(x)}</li>`).join("")}</ul>`);
    } else {
      const para: string[] = [];
      while (
        i < lines.length &&
        lines[i]!.trim() &&
        !lines[i]!.trim().startsWith("|") &&
        !lines[i]!.startsWith("- ")
      )
        para.push(lines[i++]!);
      out.push(`<p>${cellHtml(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

// ---- charts ------------------------------------------------------------------------------------------------------------
const W = 720;
const SERIES_CLASS = ["s0", "s1", "s2", "s3"];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function lineSvg(c: Chart, classes: string[]): string {
  const H = 260;
  const L = 62,
    R = 14,
    T = 12,
    B = 30;
  const vals = c.series.map((s) => s.values.map((v) => (v === null ? null : Number(v))));
  const flat = vals.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  if (!flat.length) return `<p class="empty">No data points.</p>`;
  const indexed = c.id === "price-vs-usage";
  const lo0 = Math.min(...flat);
  const hi0 = Math.max(...flat);
  const lo = indexed ? lo0 - (hi0 - lo0) * 0.05 : Math.min(0, lo0);
  const hi = indexed ? hi0 + (hi0 - lo0) * 0.05 : hi0 * 1.05 || 1;
  const px = (i: number) => L + (c.x.length <= 1 ? 0 : (i / (c.x.length - 1)) * (W - L - R));
  const py = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const grid = [0, 1, 2, 3].map((g) => {
    const v = lo + ((hi - lo) * g) / 3;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  });
  const paths = vals.map((vs, si) => {
    const segs: string[] = [];
    let cur: string[] = [];
    vs.forEach((v, i) => {
      if (v === null) {
        if (cur.length) segs.push(cur.join(" "));
        cur = [];
      } else cur.push(`${cur.length ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    });
    if (cur.length) segs.push(cur.join(" "));
    const cls = classes[si] ?? SERIES_CLASS[si % 4]!;
    const area =
      vals.length === 1 && !indexed
        ? segs
            .map(
              (s) =>
                `<path class="area ${cls}" d="${s} L${px(vs.length - 1).toFixed(1)},${py(Math.max(lo, 0)).toFixed(1)} L${px(vs.findIndex((v) => v !== null)).toFixed(1)},${py(Math.max(lo, 0)).toFixed(1)}Z"/>`,
            )
            .join("")
        : "";
    const dots = segs
      .filter((s) => !s.includes("L"))
      .map((s) => {
        const m = /M([\d.]+),([\d.]+)/.exec(s)!;
        return `<circle class="dot ${cls}" cx="${m[1]}" cy="${m[2]}" r="2.5"/>`;
      })
      .join("");
    return `${area}${segs.map((s) => `<path class="line ${cls}" d="${s}"/>`).join("")}${dots}`;
  });
  const xi = [0, Math.floor((c.x.length - 1) / 2), c.x.length - 1];
  const xl = xi.map(
    (i, k) =>
      `<text class="tick" x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === 2 ? "end" : "middle"}">${esc(c.x[i]!)}</text>`,
  );
  const legend =
    c.series.length > 1
      ? `<div class="legend">${c.series.map((s, i) => `<span><i class="sw ${classes[i] ?? SERIES_CLASS[i % 4]}"></i>${esc(s.name)}</span>`).join("")}</div>`
      : "";
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><title>${esc(c.title)}</title>${grid.join("")}${paths.join("")}${xl.join("")}</svg>`;
}

function hbarSvg(c: Chart): string {
  const vals = (c.series[0]?.values ?? []).map((v) => Number(v));
  if (!vals.length) return `<p class="empty">No data points.</p>`;
  const rowH = 26,
    L = 230,
    R = 70,
    T = 6;
  const H = T + rowH * vals.length + 6;
  const max = Math.max(...vals) || 1;
  const bars = vals.map((v, i) => {
    const y = T + i * rowH;
    const w = ((W - L - R) * v) / max;
    const name = c.x[i]!.length > 34 ? `${c.x[i]!.slice(0, 33)}…` : c.x[i]!;
    return `<text class="tick" x="${L - 8}" y="${y + 16}" text-anchor="end">${esc(name)}</text><rect class="bar s1" x="${L}" y="${y + 4}" width="${w.toFixed(1)}" height="16" rx="2"/><text class="tick" x="${(L + w + 6).toFixed(1)}" y="${y + 16}">${esc(fmt(v))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><title>${esc(c.title)}</title>${bars.join("")}</svg>`;
}

function groupedSvg(c: Chart): string {
  const H = 270,
    L = 62,
    R = 14,
    T = 22,
    B = 34;
  const data = c.series.map((s) => s.values.map((v) => (v === null ? null : Number(v))));
  const flat = data.flat().filter((v): v is number => v !== null);
  if (!flat.length) return `<p class="empty">No data points.</p>`;
  const max = niceMax(Math.max(...flat));
  const gw = (W - L - R) / c.x.length;
  const bw = Math.min(34, (gw - 18) / c.series.length);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const grid = [0, 1, 2, 3].map((g) => {
    const v = (max * g) / 3;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`;
  });
  const bars = c.x.map((x, gi) => {
    const x0 = L + gi * gw + (gw - bw * c.series.length) / 2;
    const cells = data.map((d, si) => {
      const v = d[gi];
      if (v === null || v === undefined) return "";
      const bx = x0 + si * bw;
      return `<rect class="bar ${SERIES_CLASS[si % 4]}" x="${bx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(H - B - y(v)).toFixed(1)}" rx="2"><title>${esc(c.series[si]!.name)}: ${esc(fmt(v))}</title></rect><text class="vlabel" x="${(bx + (bw - 2) / 2).toFixed(1)}" y="${(y(v) - 4).toFixed(1)}" text-anchor="middle">${esc(fmt(v))}</text>`;
    });
    return `${cells.join("")}<text class="tick" x="${(L + gi * gw + gw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">horizon ${esc(x)} days</text>`;
  });
  const legend = `<div class="legend">${c.series.map((s, i) => `<span><i class="sw ${SERIES_CLASS[i % 4]}"></i>${esc(s.name)}</span>`).join("")}</div>`;
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><title>${esc(c.title)}</title>${grid.join("")}${bars.join("")}</svg>`;
}

function chartSvg(c: Chart): string {
  if (!c.series.length) return `<p class="empty">Not computed: no data in the frozen raw files.</p>`;
  if (c.id === "forecast-comparison") return groupedSvg(c);
  if (c.kind === "bar") return hbarSvg(c);
  return lineSvg(c, c.id === "price-vs-usage" ? ["s2", "s1"] : ["s1"]);
}

function queryBlock(c: Chart): string {
  const tag = (q: Chart["queries"][number]) =>
    !q.sqlBigQuery
      ? `<span class="tag">no BigQuery source</span>`
      : q.bigQueryExecuted
        ? `<span class="tag ok">BigQuery executed${q.bigQueryBytesBilled ? `, ${esc(q.bigQueryBytesBilled)} bytes billed` : ""}</span>`
        : `<span class="tag warn">BigQuery SQL not executed in this build</span>`;
  const per = c.queries.length
    ? c.queries.map((q) => `<p class="qh"><code>${esc(q.datasetId)}</code> ${tag(q)}</p>`).join("")
    : `<p class="qh"><span class="tag">not a SQL result</span></p>`;
  return `<details class="q"><summary>Show query</summary>${per}<h4>Executed (local, produced the raw file)</h4><pre>${esc(c.sqlExecuted)}</pre>${
    c.sqlBigQuery
      ? `<h4>BigQuery source (${c.bigQueryExecuted ? "executed" : "not executed in this build"})</h4><pre>${esc(c.sqlBigQuery)}</pre>`
      : ""
  }</details>`;
}

function chartCard(c: Chart): string {
  const refs = (r: string[]) =>
    r.length
      ? ` <span class="refs">${r.map((x) => `<span class="ref" title="${esc(x)}">[${esc(x)}]</span>`).join("")}</span>`
      : "";
  return `<article class="card" id="chart-${esc(c.id)}">
<h3>${esc(c.title)}</h3>
<p class="sentence">${esc(c.sentence)}${refs(c.sentenceRefs)}</p>
${c.evidenceAgainst ? `<p class="against"><strong>Evidence against.</strong> ${esc(c.evidenceAgainst)}${refs(c.evidenceAgainstRefs)}</p>` : ""}
<div class="plot">${chartSvg(c)}</div>
<p class="meta">Unit: ${esc(c.unit || "n/a")} · Window: ${esc(c.window.from || "n/a")} to ${esc(c.window.to || "n/a")} · Source: ${esc(c.source)}</p>
<p class="meta">sha256 <code>${esc(c.sha256)}</code></p>
${c.caveats.length ? `<ul class="caveats">${c.caveats.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
${queryBlock(c)}
</article>`;
}

const CSS = `
:root{--bg:#f7f6f2;--panel:#fff;--ink:#16181d;--muted:#5a6070;--line:#e3e1d8;--accent:#1f4fd8;--warn-bg:#fff4e5;--warn-line:#d97a06;--bad-bg:#fdecec;--bad-line:#b42318;--ok:#157347;
--c0:#6b7280;--c1:#2f6fdb;--c2:#d9822b;--c3:#8b5cf6;--code:#f0eee6}
:root[data-theme=dark]{--bg:#12141a;--panel:#1b1e26;--ink:#eceae3;--muted:#a3a8b6;--line:#2c303b;--accent:#8aa8ff;--warn-bg:#2b2113;--warn-line:#e59a3c;--bad-bg:#2d1717;--bad-line:#f08a80;--ok:#5ec691;--c0:#9aa1b0;--c1:#6ea0ff;--c2:#f0a45a;--c3:#b79bff;--code:#252932}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#12141a;--panel:#1b1e26;--ink:#eceae3;--muted:#a3a8b6;--line:#2c303b;--accent:#8aa8ff;--warn-bg:#2b2113;--warn-line:#e59a3c;--bad-bg:#2d1717;--bad-line:#f08a80;--ok:#5ec691;--c0:#9aa1b0;--c1:#6ea0ff;--c2:#f0a45a;--c3:#b79bff;--code:#252932}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 80px}
header.top{padding:8px 0 20px}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
h1{font-size:clamp(24px,4vw,34px);line-height:1.2;margin:0 0 14px;letter-spacing:-.01em}
h2{font-size:21px;margin:40px 0 12px;padding-top:6px;letter-spacing:-.01em}
h3{font-size:17px;margin:0 0 8px}h4{font-size:13px;margin:14px 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.banner{background:var(--panel);border:1px solid var(--line);border-left:6px solid var(--warn-line);border-radius:10px;padding:18px 20px}
.banner .pill{display:inline-block;font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 10px;border-radius:999px;background:var(--warn-bg);color:var(--warn-line);border:1px solid var(--warn-line)}
.banner.supported{border-left-color:var(--ok)}.banner.supported .pill{color:var(--ok);border-color:var(--ok);background:transparent}
.banner p{margin:10px 0 0}
.hyp{color:var(--muted);margin:14px 0 0}.hyp b{color:var(--ink)}
nav.toc{display:flex;flex-wrap:wrap;gap:8px 16px;margin:18px 0 0;font-size:14px}nav.toc a{color:var(--accent);text-decoration:none}nav.toc a:hover{text-decoration:underline}
section>p,section>ul{max-width:76ch}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:16px 0}
.sentence{margin:0 0 10px;font-size:16.5px}
.against{margin:10px 0;padding:10px 12px;background:var(--bad-bg);border-left:4px solid var(--bad-line);border-radius:6px;font-size:14.5px}
.plot svg{width:100%;height:auto;display:block}
.plot .empty{color:var(--muted);font-style:italic}
.grid{stroke:var(--line);stroke-width:1}.tick{fill:var(--muted);font:11px ui-sans-serif,system-ui,sans-serif}.vlabel{fill:var(--ink);font:10.5px ui-sans-serif,system-ui,sans-serif}
.line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.area{stroke:none;opacity:.12}.dot{stroke:none}
.s0{stroke:var(--c0);fill:var(--c0)}.s1{stroke:var(--c1);fill:var(--c1)}.s2{stroke:var(--c2);fill:var(--c2)}.s3{stroke:var(--c3);fill:var(--c3)}
.line.s0,.line.s1,.line.s2,.line.s3{fill:none}.bar{stroke:none}
.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:13px;color:var(--muted);margin:2px 0 4px}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.meta{font-size:12.5px;color:var(--muted);margin:6px 0;word-break:break-word}
code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--code);padding:1px 5px;border-radius:4px;word-break:break-word}
pre{background:var(--code);padding:12px;border-radius:8px;overflow:auto;margin:6px 0;white-space:pre}
.caveats{font-size:13px;color:var(--muted);margin:8px 0;padding-left:20px}
details.q{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}details.q summary{cursor:pointer;color:var(--accent);font-size:14px}
.qh{margin:8px 0 0;font-size:13px}.tag{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.warn{color:var(--warn-line);border-color:var(--warn-line);background:var(--warn-bg)}
.scroll{overflow-x:auto;margin:10px 0;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:13.5px}td{overflow-wrap:anywhere}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--bg);white-space:nowrap}tr:last-child td{border-bottom:0}
.ref{font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);word-break:break-all}.hide-refs .ref,.hide-refs details.refs{display:none}details.refs summary{cursor:pointer;color:var(--accent);font-size:11.5px}details.refs .ref{display:block;margin:2px 0}
.toggle{font-size:13px;color:var(--muted);margin:14px 0 0}.toggle label{cursor:pointer}
.box{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px}
.against-first{border-left:6px solid var(--bad-line)}
ul{padding-left:22px}li{margin:4px 0}
footer{margin-top:48px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:560px){main{padding:16px 16px 60px}.card{padding:14px}}
`;

export function renderSite(t: ThesisJson): string {
  const sec = (id: string) => t.sections.find((s) => s.id === id)!;
  const secHtml = (id: string, heading: string, extra = "", cls = "") =>
    `<section id="${id}"><h2>${esc(heading)}</h2>${cls ? `<div class="box ${cls}">` : ""}${mdToHtml(sec(id).markdown)}${cls ? "</div>" : ""}${extra}</section>`;
  const forecast = t.charts.find((c) => c.id === "forecast-comparison");
  const others = t.charts.filter((c) => c.id !== "forecast-comparison");
  const claimRows = t.claims
    .map(
      (c) =>
        `<tr><td>${esc(c.statement)}<br><span class="tag">${esc(c.kind)}</span></td><td><strong>${esc(c.verdict)}</strong></td><td>${esc(c.estimate ?? "none")}</td><td>${esc(c.uncertainty ?? "none")}</td><td>${esc(c.counterexample ?? "none")}</td><td>${esc(c.falsification)}</td><td>${cellHtml(`${c.provenance} ${c.refs.map((r) => `[${r}]`).join("")}`)}</td></tr>`,
    )
    .join("");
  const tables = t.tables
    .map(
      (x) =>
        `<tr><td><code>${esc(x.name)}</code></td><td>${esc(x.system)}</td><td>${esc(x.purpose)}</td><td>${esc(x.columns.join(", "))}</td></tr>`,
    )
    .join("");
  const hashes = t.reproduce.hashes
    .map((h) => `<tr><td><code>${esc(h.path)}</code></td><td><code>${esc(h.sha256)}</code></td></tr>`)
    .join("");
  const unable = t.unableToCompute
    .map((u) => `<li><strong>${esc(u.what)}.</strong> ${esc(u.why)}</li>`)
    .join("");
  const verdictCls = t.verdict.status === "SUPPORTED" ? "supported" : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="light dark">
<title>NEAR Thesis dashboard</title>
<style>${CSS}</style></head>
<body><main>
<header class="top"><p class="eyebrow">NEAR hackathon · thesis track · version ${esc(t.version)}</p>
<h1>Is cross-chain volume through NEAR Intents a better leading indicator of network usage than token price?</h1>
<div class="banner ${verdictCls}" role="status"><span class="pill">${esc(t.verdict.status)}</span><p><strong>${esc(t.verdict.headline)}</strong></p><p>${esc(t.verdict.intentsVsPrice.summary)}</p></div>
<p class="hyp"><b>Hypothesis.</b> ${esc(t.hypothesis)} Predictive claim only; no causal claim is made.</p>
<nav class="toc"><a href="#evidence-against">Evidence against</a><a href="#claims">Claim table</a><a href="#charts">Charts</a><a href="#what-would-change-our-mind">What would change our mind</a><a href="#reproduce">Reproduce</a><a href="#unable">Unable to compute</a><a href="#tables">Tables and sample query</a><a href="#limits">Limitations</a></nav>
<p class="toggle"><label><input type="checkbox" id="refs" checked> Show source pointers (file#pointer behind each number)</label></p></header>
<section id="evidence-against"><h2>Evidence against</h2><div class="box against-first">${mdToHtml(sec("evidence-against").markdown)}</div>${forecast ? chartCard(forecast) : ""}</section>
${secHtml("evidence-for", "Evidence for")}
<section id="claims"><h2>Claim table</h2><div class="scroll"><table><thead><tr><th>Claim</th><th>Verdict</th><th>Estimate</th><th>Uncertainty</th><th>Counterexample</th><th>Falsification condition</th><th>Provenance</th></tr></thead><tbody>${claimRows}</tbody></table></div></section>
<section id="charts"><h2>Charts, each with its one sentence and its query</h2>${others.map(chartCard).join("\n")}</section>
${secHtml("what-would-change-our-mind", "What would change our mind")}
<section id="reproduce"><h2>Reproduce</h2><div class="box"><p>Rebuild everything offline from the frozen raw data, then check every hash:</p><pre>${esc(t.reproduce.command)}\n${esc(t.reproduce.check)}</pre><p class="meta">Inputs and outputs (sha256):</p><div class="scroll"><table><thead><tr><th>Path</th><th>sha256</th></tr></thead><tbody>${hashes}</tbody></table></div></div></section>
<section id="unable"><h2>Unable to compute</h2><ul>${unable}</ul></section>
<section id="tables"><h2>Tables used and a sample query</h2><div class="scroll"><table><thead><tr><th>Table</th><th>System</th><th>Purpose</th><th>Columns</th></tr></thead><tbody>${tables}</tbody></table></div><h4>${esc(t.sampleQuery.title)}</h4><pre>${esc(t.sampleQuery.sql)}</pre></section>
<section id="limits"><h2>Limitations</h2>${mdToHtml(sec("confounders-and-blind-spots").markdown)}<h3>Long-term economic mechanisms</h3>${mdToHtml(sec("long-term-economic-mechanisms").markdown)}</section>
<footer>Generated ${esc(t.generatedAt)} from frozen data; every number is read from a cited file. Full text: THESIS.md next to this site's folder.</footer>
</main>
<script>(function(){var c=document.getElementById("refs");function s(){document.body.classList.toggle("hide-refs",!c.checked)}if(c){c.addEventListener("change",s);s()}})();</script>
</body></html>
`;
}

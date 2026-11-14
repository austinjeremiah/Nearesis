/** Offline single-file site of the forecast thesis: inline CSS and SVG, no external requests. Bands are shaded, the forecast part is dashed. */
import { fmt } from "./ground.ts";
import { CSS, cellHtml, esc, mdToHtml } from "./render-site.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const W = 760;
const PAL = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c0)"];
const hsl = (i: number): string => `hsl(${(i * 47) % 360} 55% 48%)`;

function fmtAxis(v: number, share: boolean): string {
  return share ? `${fmt(v * 100)}%` : fmt(v);
}

function lineSvg(c: Any): string {
  const H = 280;
  const L = 66;
  const R = 14;
  const T = 12;
  const B = 30;
  const share = c.format === "share";
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  const named = new Map<string, (number | null)[]>(c.series.map((s: Any) => [s.name, s.values.map(num)]));
  const flat = [...named.values()].flat().filter((v): v is number => v !== null && Number.isFinite(v));
  if (!flat.length) return `<p class="empty">No data points.</p>`;
  const lo = Math.min(0, ...flat);
  const hi = (Math.max(...flat) * 1.05 || 1) as number;
  const n = c.x.length;
  const px = (i: number): number => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const py = (v: number): number => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const grid = [0, 1, 2, 3].map((g) => {
    const v = lo + ((hi - lo) * g) / 3;
    return `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v).toFixed(1)}" y2="${py(v).toFixed(1)}"/><text class="tick" x="${L - 8}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end">${esc(fmtAxis(v, share))}</text>`;
  });
  const shapes: string[] = [];
  const prefixes = [...named.keys()]
    .filter((k) => k.endsWith("band80_lo"))
    .map((k) => k.slice(0, -"band80_lo".length));
  prefixes.forEach((p, pi) => {
    const color = PAL[pi % 4]!;
    for (const [lvl, op] of [
      ["band80", 0.14],
      ["band50", 0.26],
    ] as const) {
      const lo2 = named.get(`${p}${lvl}_lo`);
      const hi2 = named.get(`${p}${lvl}_hi`);
      if (!lo2 || !hi2) continue;
      const idx = lo2.map((v, i) => (v !== null && hi2[i] !== null ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      const top = idx.map((i) => `${px(i).toFixed(1)},${py(hi2[i]!).toFixed(1)}`);
      const bot = [...idx].reverse().map((i) => `${px(i).toFixed(1)},${py(lo2[i]!).toFixed(1)}`);
      shapes.push(
        `<polygon class="band" style="fill:${color};opacity:${op}" points="${[...top, ...bot].join(" ")}"/>`,
      );
    }
  });
  const lines: string[] = [];
  let k = 0;
  for (const [name, vals] of named) {
    if (/band(50|80)_(lo|hi)$/.test(name)) continue;
    const color = prefixes.length
      ? (PAL[(prefixes.findIndex((p) => name.startsWith(p) && p !== "") % 4) + 0] ?? PAL[0]!)
      : c.series.length > 4
        ? hsl(k)
        : PAL[k % 4]!;
    const pcol =
      prefixes.length > 1
        ? PAL[
            Math.max(
              0,
              prefixes.findIndex((p) => p !== "" && name.startsWith(p)),
            ) % 4
          ]!
        : color;
    const dashed = /forecast/.test(name);
    const segs: string[] = [];
    let cur: string[] = [];
    vals.forEach((v, i) => {
      if (v === null) {
        if (cur.length) segs.push(cur.join(" "));
        cur = [];
      } else cur.push(`${cur.length ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    });
    if (cur.length) segs.push(cur.join(" "));
    lines.push(
      segs
        .map((s) => `<path class="line${dashed ? " dash" : ""}" style="stroke:${pcol}" d="${s}"/>`)
        .join(""),
    );
    k++;
  }
  const marks: string[] = [];
  if (c.forecastFrom) {
    const i = c.x.indexOf(c.forecastFrom);
    if (i > 0)
      marks.push(
        `<line class="mark" x1="${px(i).toFixed(1)}" x2="${px(i).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${(px(i) + 4).toFixed(1)}" y="${T + 10}">forecast</text>`,
      );
  }
  if (c.refLine) {
    const rv = Number(c.refLine.value);
    if (Number.isFinite(rv) && !/^\d{4}-/.test(c.refLine.value)) {
      marks.push(
        `<line class="mark" x1="${L}" x2="${W - R}" y1="${py(rv).toFixed(1)}" y2="${py(rv).toFixed(1)}"/><text class="tick" x="${W - R - 2}" y="${(py(rv) - 4).toFixed(1)}" text-anchor="end">${esc(c.refLine.label)}</text>`,
      );
    } else {
      const i = c.x.indexOf(c.refLine.value);
      if (i >= 0)
        marks.push(
          `<line class="mark" x1="${px(i).toFixed(1)}" x2="${px(i).toFixed(1)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${(px(i) + 4).toFixed(1)}" y="${T + 24}">${esc(c.refLine.label)}</text>`,
        );
    }
  }
  const xi = [0, Math.floor((n - 1) / 2), n - 1];
  const xl = xi.map(
    (i, kk) =>
      `<text class="tick" x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="${kk === 0 ? "start" : kk === 2 ? "end" : "middle"}">${esc(c.x[i]!)}</text>`,
  );
  const names = [...named.keys()].filter((nm) => !/band(50|80)_(lo|hi)$/.test(nm));
  const legend = `<div class="legend">${names
    .map(
      (nm, i) =>
        `<span><i class="sw" style="background:${
          c.series.length > 4
            ? hsl(i)
            : prefixes.length > 1
              ? PAL[
                  Math.max(
                    0,
                    prefixes.findIndex((p) => p !== "" && nm.startsWith(p)),
                  ) % 4
                ]!
              : PAL[i % 4]!
        }"></i>${esc(nm)}</span>`,
    )
    .join(
      "",
    )}${prefixes.length ? `<span><i class="sw" style="background:var(--c1);opacity:.3"></i>shaded: eighty and fifty percent bands</span>` : ""}</div>`;
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><title>${esc(c.title)}</title>${grid.join("")}${shapes.join("")}${lines.join("")}${marks.join("")}${xl.join("")}</svg>`;
}

function barSvg(c: Any): string {
  const data: (number | null)[][] = c.series.map((s: Any) =>
    s.values.map((v: string | null) => (v === null ? null : Number(v))),
  );
  const flat = data.flat().filter((v): v is number => v !== null);
  if (!flat.length) return `<p class="empty">No data points.</p>`;
  const rowH = 14 * c.series.length + 12;
  const L = 250;
  const R = 80;
  const T = 6;
  const H = T + rowH * c.x.length + 6;
  const mn = Math.min(0, ...flat);
  const mx = Math.max(0, ...flat) || 1;
  const sx = (v: number): number => L + ((v - mn) / (mx - mn || 1)) * (W - L - R);
  const zero = sx(0);
  const rows = c.x.map((name: string, i: number) => {
    const y = T + i * rowH;
    const label = name.length > 38 ? `${name.slice(0, 37)}…` : name;
    const bars = data
      .map((d, si) => {
        const v = d[i];
        if (v === null || v === undefined) return "";
        const x0 = Math.min(zero, sx(v));
        const w = Math.abs(sx(v) - zero);
        return `<rect class="bar" style="fill:${PAL[si % 4]}" x="${x0.toFixed(1)}" y="${y + 2 + si * 14}" width="${Math.max(w, 1).toFixed(1)}" height="11" rx="2"/><text class="tick" x="${(Math.max(zero, sx(v)) + 5).toFixed(1)}" y="${y + 11 + si * 14}">${esc(fmt(v))}</text>`;
      })
      .join("");
    return `<text class="tick" x="${L - 8}" y="${y + rowH / 2 + 3}" text-anchor="end">${esc(label)}</text>${bars}`;
  });
  const legend =
    c.series.length > 1
      ? `<div class="legend">${c.series.map((s: Any, i: number) => `<span><i class="sw" style="background:${PAL[i % 4]}"></i>${esc(s.name)}</span>`).join("")}</div>`
      : "";
  return `${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><title>${esc(c.title)}</title><line class="grid" x1="${zero.toFixed(1)}" x2="${zero.toFixed(1)}" y1="${T}" y2="${H}"/>${rows.join("")}</svg>`;
}

function queryBlock(c: Any): string {
  const tag = (q: Any): string =>
    !q.sqlBigQuery
      ? `<span class="tag">no BigQuery source</span>`
      : q.bigQueryExecuted
        ? `<span class="tag ok">BigQuery executed${q.bigQueryBytesBilled ? `, ${esc(q.bigQueryBytesBilled)} bytes billed` : ""}</span>`
        : `<span class="tag warn">BigQuery SQL not executed in this build</span>`;
  const per = c.queries.length
    ? c.queries.map((q: Any) => `<p class="qh"><code>${esc(q.datasetId)}</code> ${tag(q)}</p>`).join("")
    : `<p class="qh"><span class="tag">not a SQL result</span></p>`;
  return `<details class="q"><summary>Show query</summary>${per}<h4>Executed (local, produced the raw file)</h4><pre>${esc(c.sqlExecuted)}</pre>${
    c.sqlBigQuery
      ? `<h4>BigQuery source (${c.bigQueryExecuted ? "executed" : "not executed in this build"})</h4><pre>${esc(c.sqlBigQuery)}</pre>`
      : ""
  }</details>`;
}
const refsHtml = (r: string[]): string =>
  r.length
    ? ` <span class="refs">${r.map((x) => `<span class="ref" title="${esc(x)}">[${esc(x)}]</span>`).join("")}</span>`
    : "";

function chartCard(c: Any): string {
  const body = !c.series.length
    ? `<p class="empty">Not computed: no data.</p>`
    : c.kind === "bar"
      ? barSvg(c)
      : lineSvg(c);
  return `<article class="card" id="chart-${esc(c.id)}">
<h3>${esc(c.title)}</h3>
<p class="sentence">${esc(c.sentence)}${refsHtml(c.sentenceRefs)}</p>
${c.evidenceAgainst ? `<p class="against"><strong>Evidence against.</strong> ${esc(c.evidenceAgainst)}${refsHtml(c.evidenceAgainstRefs)}</p>` : ""}
<div class="plot">${body}</div>
<p class="meta">Unit: ${esc(c.unit || "n/a")} · Window: ${esc(c.window.from || "n/a")} to ${esc(c.window.to || "n/a")} · Source: ${esc(c.source)}</p>
<p class="meta">sha256 <code>${esc(c.sha256)}</code></p>
${c.caveats.length ? `<ul class="caveats">${c.caveats.map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
${queryBlock(c)}
</article>`;
}

const EXTRA_CSS = `
.band{stroke:none}.line.dash{stroke-dasharray:6 4}.mark{stroke:var(--muted);stroke-width:1;stroke-dasharray:2 3}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:14px 0}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile b{display:block;font-size:20px}.tile span{font-size:12.5px;color:var(--muted)}
.banner.forecast{border-left-color:var(--accent)}.banner.forecast .pill{color:var(--accent);border-color:var(--accent);background:transparent}
.analysis{font-weight:600}
`;

function table(head: string[], rows: string[][]): string {
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

export function renderForecastSite(t: Any, factsMd: string): string {
  void factsMd;
  const f = t.forecast;
  const sec = (id: string): string => t.sections.find((s: Any) => s.id === id)!.markdown;
  const secHtml = (id: string, heading: string, cls = ""): string =>
    `<section id="${id}"><h2>${esc(heading)}</h2>${cls ? `<div class="box ${cls}">` : ""}${mdToHtml(sec(id))}${cls ? "</div>" : ""}</section>`;
  const fv = (id: string, x: number): string => {
    const s = f.series.find((q: Any) => q.id === id);
    if (!s) return fmt(x);
    return s.transform === "logit" ? `${fmt(x * 100)}%` : fmt(x);
  };
  const tiles = f.series
    .filter((s: Any) =>
      ["take_rate_gas", "intents_burn_share", "intents_usd", "no_near_share"].includes(s.id),
    )
    .map(
      (s: Any) =>
        `<div class="tile"><span>${esc(s.label)}</span><b>${esc(fv(s.id, s.horizons[2].central))}</b><span>in ${esc(String(s.horizons[2].horizon))} days (${esc(s.horizons[2].date)}), eighty percent band ${esc(fv(s.id, s.horizons[2].band80[0]))} to ${esc(fv(s.id, s.horizons[2].band80[1]))}; now ${esc(fv(s.id, s.last30))}</span></div>`,
    );
  const co = f.derived.crossover;
  tiles.push(
    `<div class="tile"><span>Intents transactions overtake long-tail organic transactions</span><b>${esc(co.aboveAtLastDay ? "already above" : (co.centralDate ?? "not within a year"))}</b><span>probability within six months ${esc(fmt(co.within6Months * 100))}%, within twelve months ${esc(fmt(co.within12Months * 100))}%</span></div>`,
  );
  const split = f.derived.toll_split.rows.length
    ? `<h3>The toll split: cents per 100 USD settled</h3>${table(
        ["Component", "Last 30 days", "Forecast in 90 days", "Forecast in 365 days (beyond the backtest)"],
        f.derived.toll_split.rows.map((r: Any) => [
          esc(r.label),
          esc(fmt(r.centsPer100Usd.last30)),
          `${esc(fmt(r.centsPer100Usd.plus90.central))} (${esc(fmt(r.centsPer100Usd.plus90.band80[0]))} to ${esc(fmt(r.centsPer100Usd.plus90.band80[1]))})`,
          `${esc(fmt(r.centsPer100Usd.plus365.central))} (${esc(fmt(r.centsPer100Usd.plus365.band80[0]))} to ${esc(fmt(r.centsPer100Usd.plus365.band80[1]))})`,
        ]),
      )}`
    : `<p class="against"><strong>Toll split not computed.</strong> The fee inputs (thesis/raw/fees/manifest.json) are not present; a rebuild picks them up.</p>`;
  const cpRows: string[][] = [];
  for (const s of f.series) {
    if (["intents_burn_near", "usd_per_tail_signer"].includes(s.id)) continue;
    s.checkpoints.forEach((c: Any) =>
      cpRows.push([
        esc(s.label),
        esc(c.date),
        esc(fv(s.id, c.central)),
        `${esc(fv(s.id, c.band50[0]))} to ${esc(fv(s.id, c.band50[1]))}`,
        `${esc(fv(s.id, c.band80[0]))} to ${esc(fv(s.id, c.band80[1]))}`,
        esc(s.againstDirection ? `${s.againstDirection} ${fv(s.id, c.against.bound)}` : "none"),
        `<span class="tag">${esc(s.verdict)}</span>`,
      ]),
    );
  }
  const claimRows = t.claims
    .map(
      (c: Any) =>
        `<tr><td>${esc(c.statement)}<br><span class="tag">${esc(c.kind)}</span></td><td><strong>${esc(c.verdict)}</strong></td><td>${esc(c.estimate ?? "none")}</td><td>${esc(c.uncertainty ?? "none")}</td><td>${esc(c.counterexample ?? "none")}</td><td>${esc(c.falsification)}</td><td>${cellHtml(`${c.provenance} ${c.refs.map((r: string) => `[${r}]`).join("")}`)}</td></tr>`,
    )
    .join("");
  const ha = t.headAccounts;
  const headTable = table(
    ha.columns.map((c: string) => c.replace(/_/g, " ")),
    ha.rows.map((r: (string | null)[]) => r.map((x, i) => esc(i === 0 ? String(x) : fmt(Number(x))))),
  );
  const tables = t.tables
    .map(
      (x: Any) =>
        `<tr><td><code>${esc(x.name)}</code></td><td>${esc(x.system)}</td><td>${esc(x.purpose)}</td><td>${esc(x.columns.join(", "))}</td></tr>`,
    )
    .join("");
  const hashes = t.reproduce.hashes
    .map((h: Any) => `<tr><td><code>${esc(h.path)}</code></td><td><code>${esc(h.sha256)}</code></td></tr>`)
    .join("");
  const unable = t.unableToCompute
    .map((u: Any) => `<li><strong>${esc(u.what)}.</strong> ${esc(u.why)}</li>`)
    .join("");
  const toll = t.charts.filter((c: Any) =>
    [
      "forecast-take-rate-gas",
      "forecast-intents-burn-share",
      "top-fee-payers",
      "toll-split",
      "forecast-no-near-share",
    ].includes(c.id),
  );
  const rest = t.charts.filter((c: Any) => !toll.includes(c));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="color-scheme" content="light dark">
<title>${esc(t.title)}</title>
<style>${CSS}${EXTRA_CSS}</style></head>
<body><main>
<header class="top"><p class="eyebrow">NEAR hackathon · thesis track · version ${esc(t.version)}</p>
<h1>${esc(t.title)}</h1>
<div class="banner forecast" role="status"><span class="pill">${esc(t.verdict.status)}</span><p><strong>${esc(t.verdict.headline)}</strong></p><p>${esc(t.verdict.intentsVsPrice.summary)}</p></div>
<p class="hyp"><b>Question.</b> ${esc(t.question)}</p>
<p class="hyp"><b>Thesis.</b> ${esc(t.hypothesis)} Forecast only; no causal claim is made.</p>
<div class="tiles">${tiles.join("")}</div>
<nav class="toc"><a href="#toll">Toll booth</a><a href="#checkpoints">Checkpoints</a><a href="#evidence-against">Evidence against</a><a href="#claims">Claim table</a><a href="#charts">Charts</a><a href="#break">Head accounts</a><a href="#reproduce">Reproduce</a><a href="#unable">Unable to compute</a><a href="#tables">Tables and sample query</a></nav>
<p class="toggle"><label><input type="checkbox" id="refs" checked> Show source pointers (file#pointer behind each number)</label></p></header>
<section id="toll"><h2>The toll booth</h2>${split}${toll.map(chartCard).join("\n")}</section>
${secHtml("executive-claim", "Executive claim")}
<section id="checkpoints"><h2>Checkpoints</h2><p>Each checkpoint is the thirty-day average ending on the date. A realised value outside the eighty percent band in the direction against the thesis, at two consecutive checkpoints, shows the forecast wrong. Forecasts beyond ${esc(String(f.method.config.horizons[2]))} days are extrapolations the backtest cannot score.</p>${table(["Series", "Date", "Central", "Fifty percent band", "Eighty percent band", "Against the thesis if", "Verdict"], cpRows)}</section>
<section id="evidence-against"><h2>Evidence against</h2><div class="box against-first">${mdToHtml(sec("evidence-against"))}</div></section>
${secHtml("evidence-for", "Evidence for")}
<section id="claims"><h2>Claim table</h2><div class="scroll"><table><thead><tr><th>Claim</th><th>Verdict</th><th>Estimate</th><th>Uncertainty</th><th>Counterexample</th><th>Falsification condition</th><th>Provenance</th></tr></thead><tbody>${claimRows}</tbody></table></div></section>
<section id="charts"><h2>Supporting charts, each with its one sentence and its query</h2>${rest.map(chartCard).join("\n")}</section>
<section id="break"><h2>Head accounts around 2026-04-02</h2><p class="meta">${esc(ha.definition)}</p>${headTable}</section>
${secHtml("what-would-change-our-mind", "What would change our mind")}
<section id="reproduce"><h2>Reproduce</h2><div class="box"><p>Rebuild everything offline from the frozen raw data, then check every hash:</p><pre>${esc(t.reproduce.command)}\n${esc(t.reproduce.check)}</pre><div class="scroll"><table><thead><tr><th>Path</th><th>sha256</th></tr></thead><tbody>${hashes}</tbody></table></div></div></section>
<section id="unable"><h2>Unable to compute</h2><ul>${unable}</ul></section>
<section id="tables"><h2>Tables used and a sample query</h2><div class="scroll"><table><thead><tr><th>Table</th><th>System</th><th>Purpose</th><th>Columns</th></tr></thead><tbody>${tables}</tbody></table></div><h4>${esc(t.sampleQuery.title)}</h4><pre>${esc(t.sampleQuery.sql)}</pre></section>
<section id="limits"><h2>Limitations</h2>${mdToHtml(sec("confounders-and-blind-spots"))}<h3>Long-term economic mechanisms</h3>${mdToHtml(sec("long-term-economic-mechanisms"))}</section>
<footer>Generated ${esc(t.generatedAt)} from frozen data; every number is read from a cited file. Full text: THESIS.md; every citable number: FACTS.md.</footer>
</main>
<script>(function(){var c=document.getElementById("refs");function s(){document.body.classList.toggle("hide-refs",!c.checked)}if(c){c.addEventListener("change",s);s()}})();</script>
</body></html>
`;
}

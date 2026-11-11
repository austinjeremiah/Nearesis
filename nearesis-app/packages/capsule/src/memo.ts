import { clean, wrap } from "./pdf.ts";

/**
 * One-page research memo (A4, Helvetica). Text is real PDF text. Each chart is a marked-content `/Figure` with `/Alt` and
 * a `/QueryId` entry naming the SQL file in the bundle that produces its data, and is drawn with vector paths.
 */
export interface MemoInput {
  title: string;
  bull: string;
  bear: string;
  falsification: string;
  findings: Array<{ text: string; cites: string[]; number: string; range: [string, string] }>;
  charts: Array<{ queryId: string; title: string; alt: string; kind: "lines" | "interval" | "bars" }>;
  series: Array<{ name: string; values: number[] }>;
  interval: { point: number; lo: number; hi: number } | null;
  bars: Array<{ label: string; value: number }>;
}

const WORDS = ["one", "two", "three", "four", "five"];
const f2 = (n: number): string => n.toFixed(2);

function chartPath(
  c: MemoInput["charts"][number],
  m: MemoInput,
  x0: number,
  y0: number,
  w: number,
  h: number,
): string {
  const ops: string[] = [`${f2(x0)} ${f2(y0)} ${f2(w)} ${f2(h)} re S`];
  if (c.kind === "lines") {
    m.series.slice(0, 2).forEach((s, si) => {
      const base = s.values[0] || 1;
      const idx = s.values.map((v) => (v / base) * 100);
      const lo = Math.min(...m.series.flatMap((q) => q.values.map((v) => (v / (q.values[0] || 1)) * 100)));
      const hi = Math.max(...m.series.flatMap((q) => q.values.map((v) => (v / (q.values[0] || 1)) * 100)));
      const pts = idx.map(
        (v, i) =>
          `${f2(x0 + (i / Math.max(1, idx.length - 1)) * w)} ${f2(y0 + ((v - lo) / (hi - lo || 1)) * h)}`,
      );
      ops.push(
        si === 1 ? "[4 2] 0 d" : "[] 0 d",
        `${pts[0]} m ${pts
          .slice(1)
          .map((p) => `${p} l`)
          .join(" ")} S`,
      );
    });
    ops.push("[] 0 d");
  } else if (c.kind === "interval" && m.interval) {
    const { point, lo, hi } = m.interval;
    const a = Math.min(0, lo);
    const b = Math.max(0, hi);
    const X = (v: number) => x0 + ((v - a) / (b - a || 1)) * w;
    ops.push(
      `${f2(X(0))} ${f2(y0)} m ${f2(X(0))} ${f2(y0 + h)} l S`,
      `${f2(X(lo))} ${f2(y0 + h / 2)} m ${f2(X(hi))} ${f2(y0 + h / 2)} l S`,
      `${f2(X(point) - 3)} ${f2(y0 + h / 2 - 3)} 6 6 re f`,
    );
  } else if (c.kind === "bars") {
    const mx = Math.max(0.0001, ...m.bars.map((b) => Math.abs(b.value)));
    const bw = w / (m.bars.length * 2);
    m.bars.forEach((b, i) => {
      const bh = (Math.abs(b.value) / mx) * (h - 4);
      ops.push(`${f2(x0 + bw / 2 + i * bw * 2)} ${f2(y0 + 2)} ${f2(bw)} ${f2(bh)} re f`);
    });
  }
  return ops.join("\n");
}

export function renderMemoPdf(m: MemoInput): Buffer {
  const lines: string[] = [];
  const add = (t: string, size = 9): void => {
    for (const l of wrap(t, size > 10 ? 70 : 100)) lines.push(`${size}|${l}`);
  };
  add(m.title, 12);
  lines.push("9|");
  add(m.bull);
  add(m.bear);
  add(m.falsification);
  lines.push("9|");
  add("Findings", 11);
  m.findings.forEach((f, i) =>
    add(`Finding ${WORDS[i] ?? "more"}: ${f.text} ${f.cites.map((c) => `[R:${c}]`).join("")}`),
  );
  lines.push("9|");
  add("Charts (query ids resolve to sql files in this bundle)", 11);
  m.charts.forEach((c, i) => add(`Chart ${WORDS[i] ?? "more"}: ${c.title}, query ${c.queryId}`));

  let y = 800;
  let content = "";
  for (const l of lines) {
    const [sz, t] = [Number(l.split("|")[0]), l.slice(l.indexOf("|") + 1)];
    content += `BT /F1 ${sz} Tf 50 ${y} Td (${clean(t)}) Tj ET\n`;
    y -= sz + 4;
  }
  const cw = 150;
  const ch = 90;
  const gap = 20;
  const top = Math.max(120, y - ch - 12);
  m.charts.forEach((c, i) => {
    const x0 = 50 + i * (cw + gap);
    content += `/Figure <</MCID ${i} /Alt (${clean(c.alt)}) /QueryId (${clean(c.queryId)})>> BDC\n0.8 w\n${chartPath(c, m, x0, top, cw, ch)}\nEMC\n`;
    content += `BT /F1 7 Tf ${x0} ${top - 10} Td (${clean(`${c.queryId}`)}) Tj ET\n`;
  });
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

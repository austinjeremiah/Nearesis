/** Minimal deterministic text PDF (Helvetica, A4). No dates, no random ids: the same text gives the same bytes. */
const MAP: Record<string, string> = {
  "—": "-",
  "–": "-",
  "·": "-",
  "≥": ">=",
  "≤": "<=",
  "’": "'",
  "“": '"',
  "”": '"',
  "×": "x",
};

export function clean(s: string): string {
  let o = "";
  for (const ch of s) {
    const m = MAP[ch];
    if (m !== undefined) o += m;
    else o += ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127 ? ch : "?";
  }
  return o.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let cur = "";
  for (const w of line.split(" ")) {
    if (w.length > width) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      for (let i = 0; i < w.length; i += width) out.push(w.slice(i, i + width));
      continue;
    }
    if ((cur ? cur.length + 1 : 0) + w.length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

export function renderPdf(title: string, body: string[]): Buffer {
  const lines = [title, "", ...body].flatMap((l) => wrap(l, 92));
  const perPage = 56;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push([""]);
  const objs: string[] = [];
  // 1 catalog, 2 pages, 3 font, then per page: page object + content stream
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((p, i) => {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const stream = `BT /F1 ${i === 0 ? 10 : 10} Tf 13 TL 50 800 Td ${p.map((l) => `(${clean(l)}) '`).join("\n")} ET`;
    objs.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
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

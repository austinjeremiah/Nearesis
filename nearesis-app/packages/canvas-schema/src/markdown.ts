/**
 * Safe markdown for note panels (C10). The parser produces a plain-data AST; it never emits HTML and renderers build
 * text nodes from it, so markup in the source is always inert text. Raw HTML tags are kept as literal text.
 * Links are kept only for http(s) URLs; anything else (javascript:, data:, vbscript:, relative) becomes plain text.
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "em"; c: Inline[] }
  | { t: "strong"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };
export type Block =
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "pre"; v: string };

const MAX_SOURCE = 20000;
// Bidi overrides/isolates and other invisible control characters are stripped for display (ch.12 sanitizer).
function isStripped(c: number): boolean {
  return (
    (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) ||
    c === 0x7f ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

export function sanitizeDisplayText(s: string): string {
  let out = "";
  for (const ch of s) if (!isStripped(ch.codePointAt(0)!)) out += ch;
  return out;
}

export function safeHref(url: string): string | null {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function parseSafeMarkdown(source: string): Block[] {
  const lines = sanitizeDisplayText(source.slice(0, MAX_SOURCE)).split(/\r?\n/);
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", c: parseInline(para.join(" ")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) body.push(lines[i]!);
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1]!.length as 1 | 2 | 3, c: parseInline(h[2]!) });
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const kind = ul ? "ul" : "ol";
      const last = blocks[blocks.length - 1];
      const item = parseInline((ul ?? ol)![1]!);
      if (last && last.t === kind) last.items.push(item);
      else blocks.push({ t: kind, items: [item] });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return blocks;
}

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const push = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^`([^`]+)`/.exec(rest))) {
      push();
      out.push({ t: "code", v: m[1]! });
      i += m[0].length;
    } else if ((m = /^\*\*([^*]+)\*\*/.exec(rest))) {
      push();
      out.push({ t: "strong", c: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\*([^*]+)\*/.exec(rest))) {
      push();
      out.push({ t: "em", c: parseInline(m[1]!) });
      i += m[0].length;
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      push();
      const href = safeHref(m[2]!);
      if (href) out.push({ t: "link", href, c: parseInline(m[1]!) });
      else out.push({ t: "text", v: m[0] });
      i += m[0].length;
    } else {
      buf += s[i];
      i++;
    }
  }
  push();
  return out;
}

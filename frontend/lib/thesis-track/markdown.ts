/**
 * A small, safe Markdown parser for the thesis sections: headings, paragraphs, lists, tables,
 * fenced code, block quotes, rules, and inline code / bold / italic / links. It returns a plain
 * tree that React renders as elements; nothing is ever injected as HTML, and link targets are
 * limited to http(s), mailto and in-app paths.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

export function safeHref(href: string): string | null {
  const h = href.trim();
  if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
  if (h.startsWith('/') && !h.startsWith('//')) return h;
  if (h.startsWith('#')) return h;
  return null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', v: text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '\\' && i + 1 < src.length && /[\\`*_[\]()#|>-]/.test(src[i + 1]!)) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' || (ch === '_' && !/\w/.test(src[i - 1] ?? ' '))) {
      const end = src.indexOf(ch, i + 1);
      if (end > i + 1 && src[i + 1] !== ' ' && (ch === '*' || !/\w/.test(src[end + 1] ?? ' '))) {
        flush();
        out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const m = src.slice(i).match(/^\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))*)\)/);
      if (m) {
        const href = safeHref(m[2]!);
        flush();
        if (href) out.push({ t: 'link', href, c: parseInline(m[1]!) });
        else out.push(...parseInline(m[1]!));
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

const splitRow = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
};

const isSep = (line: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes('-') && (line.includes('|') || /^\s*:?-+:?\s*$/.test(line));
const isTableStart = (lines: string[], i: number) => lines[i]!.includes('|') && i + 1 < lines.length && isSep(lines[i + 1]!) && lines[i + 1]!.includes('|');
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') });
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      blocks.push({ t: 'heading', level: h[1]!.length, c: parseInline(h[2]!) });
      i += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      const head = splitRow(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() !== '' && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i]!);
        while (cells.length < head.length) cells.push('');
        rows.push(cells.slice(0, Math.max(head.length, 1)).map(parseInline));
        i += 1;
      }
      blocks.push({ t: 'table', head, rows });
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
        i += 1;
      }
      blocks.push({ t: 'quote', c: parseMarkdown(body.join('\n')) });
      continue;
    }
    const bullet = BULLET.test(line);
    if (bullet || ORDERED.test(line)) {
      const re = bullet ? BULLET : ORDERED;
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(re);
        if (m) {
          items.push(m[1]!);
          i += 1;
        } else if (/^\s{2,}\S/.test(lines[i]!) && items.length > 0 && !BULLET.test(lines[i]!) && !ORDERED.test(lines[i]!)) {
          items[items.length - 1] += ' ' + lines[i]!.trim();
          i += 1;
        } else break;
      }
      blocks.push({ t: 'list', ordered: !bullet, items: items.map(parseInline) });
      continue;
    }
    const para: string[] = [line.trim()];
    i += 1;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^\s{0,3}(#{1,6}\s|`{3,}|~{3,}|>)/.test(lines[i]!) &&
      !BULLET.test(lines[i]!) &&
      !ORDERED.test(lines[i]!) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    blocks.push({ t: 'p', c: parseInline(para.join(' ')) });
  }
  return blocks;
}

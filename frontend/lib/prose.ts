import { createElement, type ReactNode } from 'react';

/**
 * Display-only tidy-up of numbers inside agent-written sentences. The agents quote result cells at full precision
 * ("432082145.1030823 USD"), which is exact but hard to read. The exact value stays in the finding's facts and on the
 * evidence pages; here long numbers get thousands separators and long fractions are shortened. The number shown is
 * never a different number: no unit conversion, integers are never rounded, short values are left alone, and dates,
 * hashes, ids and version strings are not touched. A rewritten value keeps its exact text in `exact`.
 */

// A number token: optional minus, digits (with or without thousands commas), optional fraction. The look-arounds keep
// it away from dates (2026-08-15), times, ids (cap-ab12), hashes, versions (1.2.3) and numbers glued to letters.
const NUM = /(?<![\w.,:/#$-])(?<![\w.,:/#-]-)(-?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\w]|[.,]\d|-\d)/g;

function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Round a non-negative digit string pair half-up to `keep` fraction digits; returns [int, frac]. */
function roundFraction(int: string, frac: string, keep: number): [string, string] {
  if (frac.length <= keep) return [int, frac];
  const digits = (int + frac.slice(0, keep)).split('').map(Number);
  if (Number(frac[keep]) >= 5) {
    let i = digits.length - 1;
    while (i >= 0) {
      if (digits[i] === 9) digits[i--] = 0;
      else {
        digits[i]!++;
        break;
      }
    }
    if (i < 0) digits.unshift(1);
  }
  const all = digits.join('');
  const cut = all.length - keep;
  return [all.slice(0, cut), all.slice(cut)];
}

function tidyOne(sign: string, intRaw: string, frac: string | undefined): string | null {
  const int = intRaw.replace(/,/g, '');
  const hadCommas = intRaw.includes(',');
  if (frac === undefined) {
    // Integers only gain separators (4 digits stay as written: years, counts under ten thousand).
    if (hadCommas || int.length < 5) return null;
    return `${sign}${group(int)}`;
  }
  let keep: number;
  if (int !== '0' && int.length >= 1 && !/^0+$/.test(int)) keep = 2;
  else {
    const lead = frac.match(/^0*/)![0].length;
    keep = lead + 4; // four significant digits for values below one
  }
  if (frac.length <= keep && (hadCommas || int.length < 5)) return null;
  let [i, f] = roundFraction(int, frac, keep);
  f = /^0*$/.test(f) ? '' : keep === 2 ? f : f.replace(/0+$/, '');
  if (/^0*$/.test(i) && f === '') return null; // would collapse to zero: keep the original
  if (frac.length <= keep) f = frac;
  return `${sign}${group(i)}${f ? `.${f}` : ''}`;
}

export type NumberPart = { text: string; exact?: string };

/** Split a sentence into plain text and tidied numbers (with their exact original text). */
export function tidyNumberParts(text: string): NumberPart[] {
  const parts: NumberPart[] = [];
  let last = 0;
  for (const m of text.matchAll(NUM)) {
    const tidy = tidyOne(m[1] ?? '', m[2]!, m[3]);
    if (tidy === null || tidy === m[0]) continue;
    const at = m.index!;
    if (at > last) parts.push({ text: text.slice(last, at) });
    parts.push({ text: tidy, exact: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function tidyNumbers(text: string): string {
  return tidyNumberParts(text)
    .map((p) => p.text)
    .join('');
}

/** Same as tidyNumbers, but every rewritten number carries its exact original value as a tooltip. */
export function tidyNumberNodes(text: string): ReactNode[] {
  return tidyNumberParts(text).map((p, i) =>
    p.exact ? createElement('span', { key: i, title: `Exact value: ${p.exact}`, className: 'ag-num' }, p.text) : p.text,
  );
}

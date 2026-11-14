/**
 * Unit algebra (S05). A unit is a product of symbols with integer exponents, written `a*b/c`. `1` is dimensionless.
 * add/sub need equal units; mul/div combine exponents; a mismatch is refused, never coerced.
 */
export type Unit = Map<string, number>;

const SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseUnit(text: string): Unit | null {
  const u: Unit = new Map();
  const t = text.trim();
  if (!t) return null;
  const parts = t.split("/");
  for (let i = 0; i < parts.length; i++) {
    const sign = i === 0 ? 1 : -1;
    for (const sym of (parts[i] ?? "").split("*")) {
      const s = sym.trim();
      if (s === "1") continue;
      if (!SYMBOL.test(s)) return null;
      u.set(s, (u.get(s) ?? 0) + sign);
    }
  }
  for (const [k, v] of u) if (v === 0) u.delete(k);
  return u;
}

export function formatUnit(u: Unit): string {
  const num = [...u].filter(([, e]) => e > 0).sort(([a], [b]) => a.localeCompare(b));
  const den = [...u].filter(([, e]) => e < 0).sort(([a], [b]) => a.localeCompare(b));
  // exponents above 1 are written by repetition so the string re-parses
  const rep = (xs: Array<[string, number]>) =>
    xs.flatMap(([s, e]) => Array.from({ length: Math.abs(e) }, () => s)).join("*");
  const n = rep(num) || "1";
  const d = rep(den);
  return d ? `${n}/${d.split("*").join("/")}` : n;
}

export const normalizeUnit = (text: string): string | null => {
  const u = parseUnit(text);
  return u ? formatUnit(u) : null;
};

export function mulUnit(a: Unit, b: Unit, sign: 1 | -1): Unit {
  const out = new Map(a);
  for (const [k, e] of b) {
    const v = (out.get(k) ?? 0) + sign * e;
    if (v === 0) out.delete(k);
    else out.set(k, v);
  }
  return out;
}

export const unitsEqual = (a: Unit, b: Unit) => formatUnit(a) === formatUnit(b);

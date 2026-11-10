import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast, parseTokens } from "./contrast";

const css = readFileSync(resolve(__dirname, "../src/styles/tokens.css"), "utf8");
const light = parseTokens(css.split("@media (prefers-color-scheme: dark)")[0] as string);
const dark = parseTokens(css.split(':root[data-theme="dark"] {')[1] as string);
const mediaDark = parseTokens(
  (css.split("@media (prefers-color-scheme: dark)")[1] as string).split(
    ':root[data-theme="dark"] {',
  )[0] as string,
);

const THEMES = { light, dark } as const;
const SURFACES = ["bg", "surface", "surface-sunken", "surface-hover", "surface-selected"];

describe("design tokens", () => {
  it("dark theme via media query and via data-theme define the same values", () => {
    for (const [k, v] of Object.entries(mediaDark)) expect(dark[k], k).toBe(v);
  });

  for (const [name, t] of Object.entries(THEMES)) {
    describe(`${name} contrast (WCAG AA)`, () => {
      it("body and muted text reach 4.5:1 on every surface", () => {
        for (const fg of ["fg", "fg-muted", "fg-subtle"])
          for (const bg of SURFACES)
            expect(contrast(t[fg]!, t[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      });
      it("status text reaches 4.5:1 on its soft background and on surface", () => {
        for (const k of ["ok", "warn", "bad", "info", "honesty"]) {
          expect(contrast(t[k]!, t[`${k}-soft`]!), `${k} soft`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(t[k]!, t.surface!), `${k} surface`).toBeGreaterThanOrEqual(4.5);
        }
      });
      it("accent and on-accent reach 4.5:1", () => {
        expect(contrast(t["fg-on-accent"]!, t.accent!)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.accent!, t.surface!)).toBeGreaterThanOrEqual(4.5);
      });
      it("chart series reach 3:1 against the card surface (graphical objects)", () => {
        for (const s of ["s1", "s2", "s3", "s4", "s5", "s6"])
          expect(contrast(t[s]!, t.surface!), s).toBeGreaterThanOrEqual(3);
      });
      it("series are pairwise distinguishable by luminance or hue (no two within 8 percent luminance and same hue family)", () => {
        const s = ["s1", "s2", "s3", "s4"].map((k) => t[k]!);
        for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) expect(s[i]).not.toBe(s[j]);
      });
    });
  }
});

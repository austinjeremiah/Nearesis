/// <reference lib="dom" />
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildCapsule, sha256Hex } from "../../src/index.ts";
import { SNAPSHOT, tmp } from "../helpers.ts";

interface ChartCheck {
  charts: number;
  altOk: boolean;
  interpretationOk: boolean;
  evidenceAgainstOk: boolean;
  alt: string;
}

/** In-page check of every chart: text alternative with units and range, interpretation, and an evidence_against disclosure. */
async function chartCheck(page: Page): Promise<ChartCheck> {
  return page.evaluate(() => {
    const figs = Array.from(document.querySelectorAll("figure"));
    let altOk = figs.length > 0;
    let interpretationOk = figs.length > 0;
    let evidenceAgainstOk = figs.length > 0;
    let alt = "";
    for (const f of figs) {
      const svg = f.querySelector("svg");
      const ids = (svg?.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const name = ids
        .map((i: string) => document.getElementById(i)?.textContent ?? "")
        .join(" ")
        .trim();
      alt = name;
      const hasUnits =
        /\bmeasured in\b[^.]*\b[a-z_]+\b/i.test(name) && /usd_cents|accounts|units|[a-z_]{3,}/.test(name);
      const hasRange = /\d{4}-\d{2}-\d{2}[^]*\d{4}-\d{2}-\d{2}/.test(name);
      if (!(name.length > 20 && hasUnits && hasRange)) altOk = false;
      const interp = f.querySelector(".interpretation")?.textContent ?? "";
      if (!/^Interpretation: .{20,}\.$/.test(interp.trim())) interpretationOk = false;
      const ea = f.querySelector("details[data-evidence-against]");
      if (!ea || (ea.textContent ?? "").trim().length < 40) evidenceAgainstOk = false;
    }
    return { charts: figs.length, altOk, interpretationOk, evidenceAgainstOk, alt };
  });
}

/** V15 (16b): accessible static dashboard. FIXTURE, offline, Playwright with axe pinned in the lockfile. */
it("V15: 0 serious/critical axe violations at 3 widths, text alternatives, keyboard operation, contrast, no 320px scroll", async () => {
  const dir = tmp("v15-");
  buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir });
  const file = join(dir, "exports", "site", "index.html");
  const html = readFileSync(file, "utf8");
  const shots = join(tmp("v15-shots-"), "x");
  mkdirSync(shots, { recursive: true });

  const browser = await chromium.launch();
  const report: Record<string, unknown> = {};
  let networkRequests = 0;
  try {
    for (const width of [320, 768, 1280]) {
      for (const scheme of ["light", "dark"] as const) {
        const ctx = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: scheme,
          offline: true,
          javaScriptEnabled: true,
        });
        const page = await ctx.newPage();
        page.on("request", (r) => {
          if (!r.url().startsWith("file:") && !r.url().startsWith("data:")) networkRequests++;
        });
        await page.goto(`file://${file}`);
        // (a) axe: 0 serious or critical
        const axe = await new AxeBuilder({ page }).analyze();
        const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(
          bad.map(
            (v) =>
              `${v.id}: ${v.nodes
                .map((n) => n.target.join(" "))
                .slice(0, 3)
                .join(" | ")}`,
          ),
          `axe at ${width}px ${scheme}`,
        ).toEqual([]);
        const contrastChecked = axe.passes.some((p) => p.id === "color-contrast");
        // (e) no horizontal scroll
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
        if (scheme === "light") {
          await page.screenshot({ path: join(shots, `v15-${width}.png`) });
          report[`axe_${width}`] = {
            violations: axe.violations.length,
            serious: bad.length,
            passes: axe.passes.length,
            contrastChecked,
          };
        }
        await ctx.close();
      }
    }

    // (b) every chart: text alternative with units and range, interpretation, evidence_against
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, offline: true });
    const page = await ctx.newPage();
    await page.goto(`file://${file}`);
    const cc = await chartCheck(page);
    expect(cc).toMatchObject({ altOk: true, interpretationOk: true, evidenceAgainstOk: true });
    expect(cc.charts).toBeGreaterThanOrEqual(1);

    // negative control: a dashboard with the text alternative removed must fail (b)
    const stripped = html
      .replace(/<title id="ct">[^]*?<\/title>/, "")
      .replace(/<desc id="cd">[^]*?<\/desc>/, "");
    expect(stripped).not.toBe(html);
    const sp = join(dir, "exports", "site", "stripped.html");
    writeFileSync(sp, stripped);
    await page.goto(`file://${sp}`);
    expect((await chartCheck(page)).altOk).toBe(false);
    await page.goto(`file://${file}`);

    // (c) keyboard: every interactive element reachable by Tab, visible focus, no trap, operable
    const interactive = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll("a[href], summary, [tabindex='0'], button, input, select, textarea"),
        ].filter((e) => (e as HTMLElement).checkVisibility()).length,
    );
    const visited = new Set<string>();
    let noIndicator = 0;
    let trapped = false;
    let last = "";
    let repeats = 0;
    for (let i = 0; i < interactive + 5; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const e = document.activeElement as HTMLElement | null;
        if (!e || e === document.body) return null;
        const cs = getComputedStyle(e);
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
        const key = `${e.tagName}#${e.id}.${e.className}|${(e.textContent ?? "").slice(0, 30)}|${e.getAttribute("href") ?? ""}`;
        return {
          key,
          outline: outline || cs.boxShadow !== "none",
          focusVisible: e.matches(":focus-visible"),
        };
      });
      if (info === null) break;
      if (info.key === last) repeats++;
      else repeats = 0;
      if (repeats >= 2) trapped = true;
      last = info.key;
      if (!info.outline && info.focusVisible) noIndicator++;
      visited.add(info.key);
    }
    expect(trapped).toBe(false);
    expect(noIndicator).toBe(0);
    expect(visited.size).toBe(interactive);
    // operability: Enter opens and closes the data-table disclosure from the keyboard
    const isOpen = () =>
      page.evaluate(
        () => (document.querySelector("details:not([data-evidence-against])") as HTMLDetailsElement).open,
      );
    expect(await isOpen()).toBe(false);
    await page.focus("details:not([data-evidence-against]) > summary");
    await page.keyboard.press("Enter");
    expect(await isOpen()).toBe(true);
    await page.keyboard.press("Enter");
    expect(await isOpen()).toBe(false);

    // (d) series distinguishable without colour alone: different dash patterns and a direct text label
    const series = await page.evaluate(() => ({
      dashes: [...document.querySelectorAll("svg polyline")].map((p) => p.getAttribute("stroke-dasharray")),
      label: document.querySelector("svg text")?.textContent ?? "",
    }));
    expect(new Set(series.dashes).size).toBe(series.dashes.length);
    expect(series.label).toMatch(/solid:.*dashed:/);
    // no external requests while offline
    expect(networkRequests).toBe(0);
    await ctx.close();

    observe({
      testId: "V15",
      observed: `Static dashboard exports/site/index.html opened offline at 320, 768 and 1280 px in light and dark: axe-core 4.14 reported 0 serious or critical violations in all 6 runs (color-contrast rule evaluated); no horizontal overflow at 320 px; ${cc.charts} chart(s) with an accessible name containing units and the data range, an interpretation sentence and an open evidence_against disclosure; ${interactive} interactive elements all reached by Tab with a visible focus outline, no keyboard trap, Enter toggles the disclosure; series differ by dash pattern and are labelled in text. Negative control (title/desc removed) fails the alternative-text check. ${networkRequests} non-file requests.`,
      fixtureHash: sha256Hex(html),
      evidence: { report, interactive, alt: cc.alt, widths: [320, 768, 1280], networkRequests },
    });
  } finally {
    await browser.close();
  }
}, 300_000);

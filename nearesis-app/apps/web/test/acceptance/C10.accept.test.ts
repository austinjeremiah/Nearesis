/**
 * C10 — Hostile strings in titles, labels, tooltips, series/category values and markdown render as inert text.
 * Production build + headless Chromium, strict nonce CSP with violation listener, window.__xss tripwire.
 * Data path: fixture backend (SYNTHETIC hostile scenario) through the real validators, renderer registry, ECharts
 * adapter, table renderer and safe-markdown renderer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { observe } from "@nearesis/acceptance";
import { hashCanonical, validatePanelSpec } from "@nearesis/canvas-schema";
import { HOSTILE, loadScenario } from "../../src/fixtures/scenarios.ts";
import { launch, openPage, startWeb, stopWeb } from "./harness.ts";

let browser: Browser;
beforeAll(async () => {
  await startWeb();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
}, 120_000);

describe("C10 inert rendering of hostile strings", () => {
  it("never executes or renders payloads as markup", async () => {
    const w = await openPage(browser, "/w/fixture?scenario=hostile");
    const { page } = w;
    await page.waitForTimeout(1000);

    // Hover across every chart canvas to trigger tooltips.
    for (const el of await page.locator("[data-testid^='chart-']").all()) {
      const box = await el.boundingBox();
      if (!box) continue;
      for (let i = 1; i < 20; i++) {
        await page.mouse.move(box.x + (box.width * i) / 20, box.y + box.height / 2);
        await page.waitForTimeout(20);
      }
    }
    // Open every <details> and focus every panel to exercise remaining UI paths.
    await page.locator("[data-testid='provenance-toggle']").first().click();
    await page.waitForTimeout(300);

    const dom = await page.evaluate((payloads) => {
      const titles = [...document.querySelectorAll("[data-testid='panel-title']")].map(
        (e) => e.textContent ?? "",
      );
      const cells = [...document.querySelectorAll("table.data td")].map((e) => e.textContent ?? "");
      const md = document.querySelector(".markdown")?.textContent ?? "";
      const all = [...document.querySelectorAll("*")];
      const onAttrs = all.flatMap((e) =>
        [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => `${e.tagName}.${a.name}`),
      );
      const jsHrefs = [...document.querySelectorAll("[href],[src],[xlink\\:href]")]
        .map((e) => e.getAttribute("href") ?? e.getAttribute("src") ?? "")
        .filter((h) => /^\s*javascript:/i.test(h));
      const scripts = [...document.querySelectorAll("script")].filter((s) => !s.src && !s.nonce).length;
      const inMarkdownScripts = document.querySelectorAll(
        ".markdown script, .markdown iframe, .markdown svg, .markdown img",
      ).length;
      const charts = (
        window as unknown as { __nearesis: { charts: Record<string, { getOption: () => unknown }> } }
      ).__nearesis.charts;
      const options = Object.values(charts).map((c) => c.getOption());
      const fnPaths: string[] = [];
      const walk = (v: unknown, p: string) => {
        if (typeof v === "function") fnPaths.push(p);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
      };
      options.forEach((o, i) => walk(o, `chart${i}`));
      const categories = options.flatMap((o) =>
        ((o as { xAxis?: Array<{ data?: unknown[] }> }).xAxis ?? []).flatMap((x) => x.data ?? []),
      );
      const tooltipModes = options.map(
        (o) => (o as { tooltip?: Array<{ renderMode?: string }> }).tooltip?.[0]?.renderMode,
      );
      return {
        xss: (window as unknown as { __xss?: unknown }).__xss,
        titles,
        cellsWithPayload: payloads.filter((p) => cells.includes(p)).length,
        markdownHasAllPayloadText: payloads.every((p) => md.includes(p.replace(/[‪-‮]/g, ""))),
        onAttrs,
        jsHrefs,
        inlineScriptsWithoutNonce: scripts,
        inMarkdownScripts,
        fnPaths,
        categoriesExact: payloads.every((p) => categories.includes(p)),
        tooltipModes,
      };
    }, HOSTILE);
    const csp = await w.cspViolations();

    // (a) no execution
    expect(dom.xss).toBeUndefined();
    // (b) 0 CSP violations caused by panel content (we require 0 violations of any kind), no inline script without nonce
    expect(csp).toEqual([]);
    expect(dom.inlineScriptsWithoutNonce).toBe(0);
    // (c) literal text where displayed: titles, table cells, markdown, chart categories (canvas text)
    expect(dom.titles).toEqual(expect.arrayContaining([HOSTILE[0], HOSTILE[1], HOSTILE[3]]));
    expect(dom.cellsWithPayload).toBe(HOSTILE.length);
    expect(dom.markdownHasAllPayloadText).toBe(true);
    expect(dom.categoriesExact).toBe(true);
    expect(dom.tooltipModes.every((m) => m === "richText")).toBe(true);
    // (d) no function/formatter in any renderer option; spec formatter fields rejected by schema
    expect(dom.fnPaths).toEqual([]);
    const base = loadScenario("hostile").document as { panels: Array<Record<string, unknown>> };
    const formatterCases = [
      {
        ...base.panels[0],
        encoding: { ...(base.panels[0]!.encoding as object), formatter: "function(p){return p}" },
      },
      {
        ...base.panels[0],
        encoding: {
          ...(base.panels[0]!.encoding as object),
          tooltip: ["intents.chain"],
          valueFormatter: "{a}",
        },
      },
      { ...base.panels[0], labelFormatter: "${window.__xss=1}" },
    ];
    const formatterRejected = formatterCases.map((c) => !validatePanelSpec(c).ok);
    expect(formatterRejected).toEqual([true, true, true]);
    // (e) markdown output has no script/on*/javascript:
    expect(dom.onAttrs).toEqual([]);
    expect(dom.jsHrefs).toEqual([]);
    expect(dom.inMarkdownScripts).toBe(0);
    expect(w.consoleErrors.filter((e) => /xss|Refused to execute/i.test(e))).toEqual([]);

    observe({
      testId: "C10",
      observed: `${HOSTILE.length} hostile payloads in titles, units, category values (bar axis + tooltip), table cells and markdown (text, links, code block): window.__xss undefined after hovering all charts; 0 CSP violations; 0 on* attributes; 0 javascript: URLs; 0 markup elements inside markdown; all payloads shown as literal text (DOM titles/cells/markdown, exact canvas category strings); tooltips richText; 0 functions in renderer options; 3/3 spec formatter fields rejected by schema`,
      fixtureHash: hashCanonical(loadScenario("hostile")),
      evidence: {
        ...dom,
        csp,
        formatterRejected,
        consoleErrors: w.consoleErrors.slice(0, 10),
        mode: "fixture backend, SYNTHETIC hostile scenario",
      },
    });
    await page.close();
  }, 180_000);
});

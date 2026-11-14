import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { buildCapsule, readManifest, sha256Hex } from "../../src/index.ts";
import { RESEARCH_BUNDLE, SNAPSHOT, tmp } from "../helpers.ts";

/** V07 (ch.16): export memo and static site; builds, opens offline, queries and limitations visible. */
it("V07: THESIS/DATA/LIMITATIONS, PDF memo and static site build and open offline", async () => {
  const dir = tmp("v07-");
  const m = buildCapsule({ snapshotDir: SNAPSHOT, outDir: dir, researchBundleDir: RESEARCH_BUNDLE });
  const man = readManifest(dir)!;
  const ex = (n: string) => join(dir, "exports", n);

  for (const n of ["THESIS.md", "DATA.md", "LIMITATIONS.md", "memo.pdf", "site/index.html"]) {
    const b = readFileSync(ex(n));
    expect(b.length, n).toBeGreaterThan(200);
    const e = man.publication.files.find((f) => f.path === `exports/${n}`)!;
    expect(sha256Hex(b)).toBe(e.sha256);
  }
  // PDF structure: header, xref offsets point at objects, EOF marker, extractable text with limitations
  const pdf = readFileSync(ex("memo.pdf")).toString("latin1");
  expect(pdf.startsWith("%PDF-1.4")).toBe(true);
  expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
  const xrefAt = Number(/startxref\n(\d+)/.exec(pdf)![1]);
  expect(pdf.slice(xrefAt, xrefAt + 4)).toBe("xref");
  const offs = [...pdf.slice(xrefAt).matchAll(/(\d{10}) 00000 n /g)].map((x) => Number(x[1]));
  offs.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
  expect(pdf).toContain("Limitations");
  expect(pdf).toContain("SYNTHETIC");

  // static site opened from file:// in a real browser with the network switched off
  const browser = await chromium.launch();
  const requests: string[] = [];
  const consoleErrors: string[] = [];
  try {
    const ctx = await browser.newContext({ offline: true });
    const page = await ctx.newPage();
    page.on("request", (r) => requests.push(r.url()));
    page.on("console", (c) => c.type() === "error" && consoleErrors.push(c.text()));
    await page.goto(`file://${ex("site/index.html")}`);
    expect(await page.locator("html").getAttribute("lang")).toBe("en");
    await expect(page.getByRole("heading", { name: "Queries and computation" }).isVisible()).resolves.toBe(
      true,
    );
    await expect(page.getByRole("heading", { name: "Limitations" }).isVisible()).resolves.toBe(true);
    expect(await page.locator("pre").first().innerText()).toContain("metric: lag_pearson:7");
    expect(await page.locator("h2#limitations + ul li").count()).toBeGreaterThanOrEqual(5);
    expect(await page.locator("svg[role=img] title").count()).toBe(1);
    expect(await page.locator("figure svg polyline").count()).toBe(2);
    expect(await page.locator("details table tbody tr").count()).toBe(90);
    expect(await page.locator("body").innerText()).toContain("SYNTHETIC DATA");
    expect(await page.locator("script").count()).toBe(0);
  } finally {
    await browser.close();
  }
  expect(requests.every((u) => u.startsWith("file://"))).toBe(true);
  expect(consoleErrors).toEqual([]);
  const html = readFileSync(ex("site/index.html"), "utf8");
  expect(html).not.toMatch(/(?:src|href)="https?:/);

  observe({
    testId: "V07",
    observed: `Exports built and hash-matched to the manifest (THESIS.md, DATA.md, LIMITATIONS.md, memo.pdf ${readFileSync(ex("memo.pdf")).length} bytes with valid xref, site/index.html). Site opened from file:// in headless Chromium with the network off: ${requests.length} request(s), all file://; 0 console errors; queries section lists the metrics; ${5}+ limitations visible; chart is an SVG with title and a 90-row data table; no scripts.`,
    fixtureHash: m.snapshot.dataHash,
    evidence: {
      requests: requests.length,
      offline: true,
      pdfBytes: readFileSync(ex("memo.pdf")).length,
      capsuleHash: m.capsuleHash,
    },
  });
}, 120_000);

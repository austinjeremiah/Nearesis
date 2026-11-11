/**
 * Thesis dashboard browser tests (real web app, real kernel session, real semantic gateway; Playwright Chromium).
 * Not a defined acceptance ID: results are reported as browser-test results only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Env, loggedIn, open, startEnv, WEB_DIR } from "./harness.ts";
import { syntheticArtifacts } from "./synthetic.ts";

const OUT = `${WEB_DIR}test-results/thesis`;
let env: Env;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
}, 600_000);
afterAll(async () => {
  await env?.close();
});

type Win = {
  __thesis: {
    ready: boolean;
    data: {
      sourceLabel: string;
      series: Array<{
        key: string;
        rows: Array<[string, number | null]>;
        coverage: { expectedDays: number; observedDays: number; missingDays: number };
        error: unknown;
      }>;
    };
    artifacts: { status: string };
    report: { sha256: string; body: unknown };
  };
};

/** Under `next dev`, Next's own devtools bundle injects styles; those are not page content and are excluded. */
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;

const SOURCE = process.env.NEARESIS_THESIS_SOURCE === "fixture" ? "fixture" : "live";

describe("thesis dashboard", () => {
  it("shows observed series with coverage, refuses to invent research results, and exports exactly what it renders", async () => {
    rmSync(env.files.artifacts, { force: true });
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(
      ctx,
      `/w/${env.workspaceId}/thesis?source=${SOURCE}`,
      "__thesis",
    );
    await page.waitForTimeout(1500); // let charts paint for the screenshot
    const t = await page.evaluate(() => (window as unknown as Win).__thesis);

    // Research is unavailable: no verdict, no statistics.
    await expect(page.getByTestId("research-unavailable").isVisible()).resolves.toBe(true);
    expect(await page.getByTestId("verdict").count()).toBe(0);
    expect(await page.getByTestId("lag-table").count()).toBe(0);
    // Five claim classes are distinguished.
    expect(await page.getByTestId("claim-legend").locator("[data-testid^='claim-tag-']").count()).toBe(5);
    // Coverage is consistent with the rows; nulls stay null (missing is never zero).
    const coverage = t.data.series.map((x) => {
      const nonNull = x.rows.filter((r) => r[1] !== null).length;
      return {
        key: x.key,
        rows: x.rows.length,
        nonNull,
        ...x.coverage,
        consistent:
          nonNull === x.coverage.observedDays &&
          x.coverage.observedDays + x.coverage.missingDays === x.coverage.expectedDays,
        error: x.error,
      };
    });
    expect(coverage.every((c) => c.consistent)).toBe(true);
    for (const c of coverage)
      await expect(page.getByTestId(`coverage-${c.key}`).textContent()).resolves.toContain(
        `${c.observedDays}/${c.expectedDays} days observed`,
      );
    // Every series card carries a chart record (source, query, definition, window, snapshot, computation, limits).
    expect(await page.getByTestId("chart-record").count()).toBeGreaterThanOrEqual(t.data.series.length);

    // Export equals the rendered state.
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-json").click()]);
    const exported = JSON.parse(readFileSync((await dl.path())!, "utf8")) as {
      sha256: string;
      series: unknown;
    };
    expect(exported.sha256).toBe(t.report.sha256);
    expect(exported.series).toEqual((t.report.body as { series: unknown }).series);

    // Reproducibility control: re-run the certified queries and compare result hashes.
    await page.getByTestId("check-repro").click();
    await page.getByTestId("repro-result").waitFor({ timeout: 60_000 });
    const repro = await page.getByTestId("repro-result").textContent();
    if (SOURCE === "fixture") expect(repro).not.toContain("changed");

    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/thesis-dashboard-${SOURCE}.png`, fullPage: true });
    writeFileSync(
      `${OUT}/result-unavailable.json`,
      JSON.stringify(
        { source: SOURCE, sourceLabel: t.data.sourceLabel, coverage, repro, reportSha256: t.report.sha256 },
        null,
        2,
      ),
    );
    await ctx.close();
  }, 600_000);

  it("labels SYNTHETIC research artifacts, separates claim classes and demotes claims citing missing results", async () => {
    writeFileSync(env.files.artifacts, JSON.stringify(syntheticArtifacts()));
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(
      ctx,
      `/w/${env.workspaceId}/thesis?source=${SOURCE}`,
      "__thesis",
    );
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("synthetic-banner").textContent()).resolves.toMatch(
      /research results are a labelled test fixture/,
    );
    await expect(page.getByTestId("verdict").textContent()).resolves.toContain("INSUFFICIENT DATA");
    expect(await page.getByTestId("lag-table").locator("tbody tr").count()).toBe(10);
    await expect(page.getByTestId("model-table").textContent()).resolves.toContain("not computed");
    // E1 cites an existing result -> derived; E4 cites a result absent from the artifacts -> unsupported.
    await expect(page.getByTestId("evidence-item-E1").getAttribute("data-class")).resolves.toBe("derived");
    await expect(page.getByTestId("evidence-item-E2").getAttribute("data-class")).resolves.toBe(
      "interpretation",
    );
    await expect(page.getByTestId("evidence-item-E4").getAttribute("data-class")).resolves.toBe(
      "unsupported",
    );
    await expect(page.getByTestId("hypothesis").getAttribute("data-class")).resolves.toBe("hypothesis");
    await expect(page.getByTestId("falsification").textContent()).resolves.toContain("not evaluated");
    expect(await page.getByTestId("capsule-link").getAttribute("href")).toBe(
      `/w/${env.workspaceId}/capsule?id=cap-synthetic-1`,
    );
    expect(await page.getByTestId("evidence-graph-link").count()).toBe(1);
    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.getByTestId("lag-table").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/thesis-research-synthetic.png`, fullPage: true });
    rmSync(env.files.artifacts, { force: true });
    await ctx.close();
  }, 600_000);

  it("rejects an out-of-range window and refuses access without a workspace session", async () => {
    const ctx = await loggedIn(env);
    const bad = await ctx.request.get(
      `http://127.0.0.1:${process.env.NEARESIS_WEB_PORT ?? 3620}/w/${env.workspaceId}/thesis/data?from=2020-01-01&to=2026-01-01`,
    );
    expect(bad.status()).toBe(422);
    const anon = await env.browser.newContext();
    const r = await anon.request.get(
      `http://127.0.0.1:${process.env.NEARESIS_WEB_PORT ?? 3620}/w/${env.workspaceId}/thesis/data?from=2026-10-01&to=2026-10-31`,
    );
    expect(r.status()).toBe(404);
    await anon.close();
    await ctx.close();
  }, 120_000);
});

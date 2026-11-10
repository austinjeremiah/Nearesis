/**
 * C18 — Panel state machine, revision separation and bounded large-series rendering.
 * Thresholds and reference environment are read from test/perf/C18.reference.json (committed before the first run,
 * 9ed0d55). If this machine's fingerprint differs from the reference, the run is not a PASS/FAIL: it is reported as
 * blocked (the runner has no NOT_RUN verdict for executed tests).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, release, totalmem, type } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright";
import { observe } from "@nearesis/acceptance";
import { canTransition, hashCanonical, type PanelState } from "@nearesis/canvas-schema";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { launch, openPage, startWeb, stopWeb, WEB_DIR } from "./harness.ts";

const REF_PATH = `${WEB_DIR}test/perf/C18.reference.json`;
const refBytes = readFileSync(REF_PATH);
const REF = JSON.parse(refBytes.toString()) as {
  environment: Record<string, unknown>;
  datasets: Record<string, string>;
  thresholds: {
    maxDomElementsPerChartPanel: number;
    maxHeapIncreaseMB_100kPanel: number;
    maxFirstFrameMs_100kSeries: number;
    maxFirstFrameMs_50kScatter: number;
    maxMainThreadTaskMs: number;
  };
};

type Hooks = {
  __nearesis: {
    stateLog: Record<string, PanelState[]>;
    firstFrameMs: Record<string, number>;
    charts: Record<string, { getOption: () => { series: Array<{ data: Array<[number, number | null]> }> } }>;
    doc: { revision: number; dataRevision: number };
    backend: {
      failQuery: (h: string, f: boolean) => void;
      advanceVintage: () => void;
      injectEvent: (t: string, d: unknown) => void;
    };
    refreshPanel: (id: string) => void;
    lastError: string | null;
  };
  __longtasks: number[];
};

let browser: Browser;
beforeAll(async () => {
  await startWeb();
  browser = await launch();
}, 300_000);
afterAll(async () => {
  await browser?.close();
  await stopWeb();
}, 120_000);

async function heapAfterGc(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const m = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  return m.metrics.find((x) => x.name === "JSHeapUsedSize")!.value;
}

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";

describe("C18 panel states, revisions and large series", () => {
  it("meets the frozen thresholds in the reference environment", async () => {
    const env = {
      cpuModel: cpus()[0]!.model,
      cpuCores: cpus().length,
      ramGiB: Math.round(totalmem() / 2 ** 30),
      os: `${type()} ${release()}`,
      arch: process.arch,
      node: process.version,
      playwright: (
        JSON.parse(readFileSync(`${WEB_DIR}node_modules/playwright/package.json`, "utf8")) as {
          version: string;
        }
      ).version,
      chromium: browser.version(),
    };
    const refEnv = REF.environment;
    const mismatches = Object.entries(env).filter(([k, v]) => refEnv[k] !== v);
    const datasets = {
      "fx.canvas.state-cases/large": hashCanonical(loadScenario("large")),
      "fx.canvas.state-cases/baseline": hashCanonical(loadScenario("baseline")),
    };
    const datasetMismatch = Object.entries(datasets).filter(([k, v]) => REF.datasets[k] !== v);
    const referenceSha256 = createHash("sha256").update(refBytes).digest("hex");
    if (mismatches.length || datasetMismatch.length) {
      observe({
        testId: "C18",
        observed: "reference environment mismatch; not executed",
        blocked: `NOT_RUN: environment differs from C18.reference.json: ${JSON.stringify({ mismatches, datasetMismatch })}`,
        evidence: { env, referenceSha256 },
      });
      return;
    }

    // ---- Part 1: large series (100k line + 50k scatter): DOM, heap, first frame, long tasks, downsampling.
    const init = (p: Page) =>
      p.addInitScript(() => {
        const w = window as unknown as { __longtasks: number[] };
        w.__longtasks = [];
        new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__longtasks.push(e.duration))).observe(
          { type: "longtask", buffered: true },
        );
      });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await init(page);
    await page.goto("http://127.0.0.1:3100/w/fixture?scenario=empty");
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );
    await page.waitForTimeout(500);
    const heapBefore = await heapAfterGc(page);
    await page.goto("http://127.0.0.1:3100/w/fixture?scenario=large");
    await page.waitForFunction(
      () => Object.keys((window as unknown as Hooks).__nearesis?.firstFrameMs ?? {}).length === 2,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(500);
    const heapAfter = await heapAfterGc(page);
    const initialLong = await page.evaluate(() => [...(window as unknown as Hooks).__longtasks]);
    const large = await page.evaluate(
      ([p1, p2]) => {
        const h = (window as unknown as Hooks).__nearesis;
        const s1 = h.charts[p1!]!.getOption().series[0]!.data;
        const values = s1.map((d) => d[1]);
        return {
          firstFrame: h.firstFrameMs,
          domPerPanel: [...document.querySelectorAll("[data-panel-kind]")].map((p) => ({
            kind: p.getAttribute("data-panel-kind"),
            elements: p.querySelectorAll("*").length,
          })),
          downsamplingLabel: document.querySelector(
            `[data-testid='panel-${p1}'] [data-testid='downsampling']`,
          )?.textContent,
          renderedPoints: s1.length,
          spikeHigh: values.includes(9999),
          spikeLow: values.includes(-500),
          scatterPoints: h.charts[p2!]!.getOption().series[0]!.data.length,
        };
      },
      [P1, P2],
    );
    // Pan and zoom for 5 s with the mouse wheel and drags over the 100k chart.
    await page.evaluate(() => ((window as unknown as Hooks).__longtasks.length = 0));
    const box = (await page.locator(`[data-testid='chart-${P1}']`).boundingBox())!;
    const t0 = Date.now();
    let step = 0;
    while (Date.now() - t0 < 5000) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, step % 2 ? 300 : -300);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + (step % 2 ? 80 : -80), box.y + box.height / 2, {
        steps: 4,
      });
      await page.mouse.up();
      step++;
    }
    const panLong = await page.evaluate(() => [...(window as unknown as Hooks).__longtasks]);
    await ctx.close();

    // ---- Part 2: state machine and revision separation on the baseline canvas.
    const w = await openPage(browser, "/w/fixture?scenario=baseline");
    const pg = w.page;
    await pg.waitForTimeout(500);
    const revs = () =>
      pg.evaluate(() => ({
        doc: (window as unknown as Hooks).__nearesis.doc.revision,
        data: (window as unknown as Hooks).__nearesis.doc.dataRevision,
      }));
    const r0 = await revs();
    // layout drag (keyboard move = same movePanel command)
    await pg.locator(`[data-testid='panel-${P1}']`).focus();
    await pg.keyboard.press("Alt+ArrowDown");
    await pg.waitForFunction((d) => (window as unknown as Hooks).__nearesis.doc.revision === d + 1, r0.doc);
    const r1 = await revs();
    // watermark late -> STALE, then fresh -> REFRESHING -> READY (data refresh)
    await pg.evaluate(() => {
      const h = (window as unknown as Hooks).__nearesis;
      h.backend.advanceVintage();
      h.backend.injectEvent("snapshot.finalized", {
        kind: "watermark",
        providerId: "near-explorer",
        state: "late",
      });
    });
    await pg.waitForSelector(`[data-testid='panel-${P1}'][data-panel-state='STALE']`);
    await pg.evaluate(() =>
      (window as unknown as Hooks).__nearesis.backend.injectEvent("snapshot.finalized", {
        kind: "watermark",
        providerId: "near-explorer",
        state: "fresh",
      }),
    );
    await pg.waitForSelector(`[data-testid='panel-${P1}'][data-panel-state='READY']`);
    await pg.waitForTimeout(200);
    const r2 = await revs();
    // query fails after a successful load -> ERROR keeps last good data
    const hash = await pg.evaluate((id) => {
      const h = (window as unknown as Hooks).__nearesis;
      const opt = h.charts[id]!.getOption();
      return { points: opt.series[0]!.data.length };
    }, P1);
    const qh = (loadScenario("baseline").document as { panels: Array<{ queryRef: { hash: string } }> })
      .panels[0]!.queryRef.hash;
    await pg.evaluate(
      ([q, id]) => {
        const h = (window as unknown as Hooks).__nearesis;
        h.backend.failQuery(q!, true);
        h.refreshPanel(id!);
      },
      [qh, P1],
    );
    await pg.waitForSelector(`[data-testid='panel-${P1}'][data-panel-state='ERROR']`);
    const errorView = await pg.evaluate((id) => {
      const h = (window as unknown as Hooks).__nearesis;
      const p = document.querySelector(`[data-testid='panel-${id}']`)!;
      return {
        notice: p.querySelector("[data-testid='error-notice']")?.textContent,
        chartStillRendered: Boolean(h.charts[id]) && p.querySelectorAll("canvas").length > 0,
        points: h.charts[id]!.getOption().series[0]!.data.length,
        stateLog: h.stateLog,
        lastError: h.lastError,
      };
    }, P1);
    await pg.close();

    // ---- Assertions
    // (a) legal transitions only
    const illegal: string[] = [];
    for (const [id, seq] of Object.entries(errorView.stateLog))
      for (let i = 1; i < seq.length; i++)
        if (!canTransition(seq[i - 1]!, seq[i]!)) illegal.push(`${id}:${seq[i - 1]}->${seq[i]}`);
    expect(illegal).toEqual([]);
    expect(errorView.lastError).toBeNull();
    expect(errorView.stateLog[P1]).toEqual([
      "DRAFT",
      "VALIDATING",
      "QUERYING",
      "READY",
      "STALE",
      "REFRESHING",
      "READY",
      "REFRESHING",
      "ERROR",
    ]);
    // (b) ERROR: structured code, last good data still rendered and labelled
    expect(errorView.notice).toMatch(/^QUERY_FAILED: .* showing last good data\.$/);
    expect(errorView.chartStillRendered).toBe(true);
    expect(errorView.points).toBe(hash.points);
    // (c) revisions independent
    expect(r1).toEqual({ doc: r0.doc + 1, data: r0.data });
    expect(r2).toEqual({ doc: r1.doc, data: r1.data + 1 });
    // (d) declared downsampling preserves spikes
    expect(large.downsamplingLabel).toMatch(/^downsampling: min_max_bucket \(\d+\/100000 pts\)$/);
    expect(large.spikeHigh && large.spikeLow).toBe(true);
    expect(large.scatterPoints).toBe(50_000);
    // (e) frozen thresholds
    const T = REF.thresholds;
    const heapMB = (heapAfter - heapBefore) / 2 ** 20;
    const maxDom = Math.max(...large.domPerPanel.map((d) => d.elements));
    expect(maxDom).toBeLessThanOrEqual(T.maxDomElementsPerChartPanel);
    expect(heapMB).toBeLessThanOrEqual(T.maxHeapIncreaseMB_100kPanel);
    expect(large.firstFrame[P1]!).toBeLessThanOrEqual(T.maxFirstFrameMs_100kSeries);
    expect(large.firstFrame[P2]!).toBeLessThanOrEqual(T.maxFirstFrameMs_50kScatter);
    // (f) no main-thread task > 250 ms during initial render or the 5 s pan/zoom script
    const maxInitial = Math.max(0, ...initialLong);
    const maxPan = Math.max(0, ...panLong);
    expect(maxInitial).toBeLessThanOrEqual(T.maxMainThreadTaskMs);
    expect(maxPan).toBeLessThanOrEqual(T.maxMainThreadTaskMs);

    observe({
      testId: "C18",
      observed: `env matches frozen reference (sha256 ${referenceSha256.slice(0, 12)}); legal transitions only, P1 sequence DRAFT>VALIDATING>QUERYING>READY>STALE>REFRESHING>READY>REFRESHING>ERROR; ERROR shows QUERY_FAILED and keeps last good data rendered (${errorView.points} pts); layout move doc ${r0.doc}->${r1.doc} data ${r0.data}->${r1.data}; refresh doc ${r1.doc}->${r2.doc} data ${r1.data}->${r2.data}; 100k series min_max_bucket ${large.renderedPoints} pts with both spikes; max DOM/panel ${maxDom} (<=5000); heap +${heapMB.toFixed(1)} MB (<=150); first frame 100k ${large.firstFrame[P1]!.toFixed(0)} ms, 50k scatter ${large.firstFrame[P2]!.toFixed(0)} ms (<=3000); max long task initial ${maxInitial.toFixed(0)} ms, pan/zoom ${maxPan.toFixed(0)} ms over ${step} gestures (<=250)`,
      fixtureHash: hashCanonical(datasets),
      evidence: {
        referenceSha256,
        env,
        datasets,
        large,
        heapBefore,
        heapAfter,
        heapMB,
        initialLongTasks: initialLong,
        panLongTasks: panLong,
        revisions: { r0, r1, r2 },
        errorView,
      },
    });
  }, 300_000);
});

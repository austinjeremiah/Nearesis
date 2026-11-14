/**
 * PERF05: cached workspace load p95 < 1.5 s and mutation acknowledgement p95 < 250 ms (ch.13; ch.16b 6.2).
 * Real kernel + API, the production web build and Playwright Chromium, 20 workspaces of 4-12 panels, 20 concurrent
 * users. Cached load: every workspace loaded 50 times after a warm-up. Cold load: after the web server is restarted
 * (cache flush) with fresh browser contexts; reported separately and never used for the cached judgement.
 * Mutations (layout move by keyboard, threshold-marker create by button, note edit through the UI's own apply path):
 * client acknowledgement is the user-visible DOM change, server confirmation is the command round trip. The product
 * has no separate optimistic layer, so the DOM change follows the confirmed command and reload; the judgement applies
 * the 250 ms bound to that real, stricter figure.
 */
import type { BrowserContext, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { DRYRUN, percentile, sha256Text, stats } from "./_reference.ts";
import { evidenceBase, gateB, histogram, referenceB, thr } from "./_b.ts";
import { startStack, type Stack } from "./_stack.ts";

const th = thr("PERF05");
export const FIXTURE_SPEC = {
  workspaces: th.workspaces,
  panelsPerWorkspace:
    "4 + (i % 9) panels of the baseline scenario cycled, 3x3 cells in 12 columns, i = 0..19",
  loads: `${th.loadsPerWorkspace} per workspace by ${th.concurrentUsers} concurrent users`,
  mutations: `${th.mutations} = 20 users x 25, rotating layout move / threshold marker / note edit`,
  cold: "web server restarted, fresh contexts, one load per user",
  negativeControl: "400 ms added to every command response",
  viewport: { width: 1440, height: 900 },
};

const g = gateB(import.meta.url);
let stack: Stack | null = null;
let blocked: string | null = null;
beforeAll(async () => {
  if (!g.ok && !DRYRUN) return;
  // 20 distinct users: the API rate-limits per credential, so one shared principal would not be 20 users.
  const members = Object.fromEntries(
    Array.from({ length: th.concurrentUsers! }, (_, i) => [`u${i}`, "owner" as const]),
  );
  const s = await startStack({ apiPort: 4751, webPort: 3651, org: "perf05", members });
  if ("blocked" in s) blocked = s.blocked;
  else stack = s;
}, 900_000);
afterAll(async () => stack?.close(), 120_000);

/** Pass/fail judgement of an acknowledgement sample set: the same function judges the real run and the control. */
export const ackPasses = (samples: number[], boundMs: number): boolean =>
  samples.length > 0 &&
  percentile(
    [...samples].sort((a, b) => a - b),
    95,
  ) < boundMs;

const INIT = `
window.__perf = { saw: false, ready: null, lcp: 0, cmds: [], errors: [] };
new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__perf.lcp = e.startTime))).observe({ type: "largest-contentful-paint", buffered: true });
new MutationObserver(() => { if (document.querySelector('[aria-busy="true"]')) window.__perf.saw = true; })
  .observe(document, { subtree: true, childList: true, attributes: true });
const f = window.fetch.bind(window);
window.fetch = async (...a) => {
  const u = String(a[0] && a[0].url ? a[0].url : a[0]);
  const m = (a[1] && a[1].method) || "GET";
  const t = performance.now();
  try {
    const r = await f(...a);
    if (m === "POST" && u.includes("/commands")) window.__perf.cmds.push({ ms: performance.now() - t, status: r.status });
    if (r.status >= 400) window.__perf.errors.push(m + " " + u + " " + r.status);
    return r;
  } catch (e) { window.__perf.errors.push(m + " " + u + " " + e); throw e; }
};
window.addEventListener("error", (e) => window.__perf.errors.push("pageerror " + e.message));
const check = () => {
  const w = window.__nearesis;
  const els = document.querySelectorAll("[data-panel-kind]");
  const loading = [...els].some((e) => ["VALIDATING", "QUERYING", "none", ""].includes(e.getAttribute("data-panel-state") || ""));
  if (w && w.ready === true && els.length >= window.__expected && !loading) window.__perf.ready = performance.now();
  else requestAnimationFrame(check);
};
requestAnimationFrame(check);
`;

interface Ws {
  workspaceId: string;
  chartId: string;
  noteId: string;
  note: Record<string, unknown>;
  panels: number;
}

async function openWorkspace(ctx: BrowserContext, base: string, ws: Ws): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(`window.__expected = ${ws.panels};` + INIT);
  await page.goto(`${base}/w/${ws.workspaceId}?backend=kernel`, { waitUntil: "commit" });
  await page.waitForFunction(
    () => (window as unknown as { __perf: { ready: number | null } }).__perf?.ready != null,
    null,
    {
      timeout: 60_000,
      polling: 20,
    },
  );
  return page;
}

interface LoadSample {
  ms: number;
  lcp: number;
  skeleton: boolean;
  ttfb: number[];
  errors: string[];
}
async function measureLoad(ctx: BrowserContext, base: string, ws: Ws): Promise<LoadSample> {
  const page = await openWorkspace(ctx, base, ws);
  const r = await page.evaluate(() => {
    const p = (
      window as unknown as { __perf: { ready: number; lcp: number; saw: boolean; errors: string[] } }
    ).__perf;
    const ttfb = performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/api/"))
      .map(
        (e) => (e as PerformanceResourceTiming).responseStart - (e as PerformanceResourceTiming).requestStart,
      );
    return { ms: p.ready, lcp: p.lcp, skeleton: p.saw, ttfb, errors: p.errors };
  });
  await page.close();
  return r;
}

const ackIn = (page: Page, kind: "move" | "marker" | "note", ws: Ws, i: number) =>
  page.evaluate(
    ([k, chartId, noteId, note, n]) =>
      new Promise<number>((resolve) => {
        const w = window as unknown as {
          __nearesis: { applyOps: (o: unknown[]) => Promise<boolean> };
        };
        const finish = (t: number) => (v: number) => resolve(v < 0 ? -1 : performance.now() - t);
        const t = performance.now();
        const done = finish(t);
        const watch = (el: Element, opts: MutationObserverInit, ok: () => boolean) => {
          const mo = new MutationObserver(() => {
            if (!ok()) return;
            mo.disconnect();
            requestAnimationFrame(() => done(0));
          });
          mo.observe(el, opts);
          setTimeout(() => {
            mo.disconnect();
            done(-1);
          }, 8000);
        };
        if (k === "move") {
          const el = document.querySelector(`[data-testid='panel-${chartId}']`) as HTMLElement;
          watch(el, { attributes: true, attributeFilter: ["style"] }, () => true);
          el.focus();
          el.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: (n as number) % 2 === 0 ? "ArrowDown" : "ArrowUp",
              altKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        } else if (k === "marker") {
          const el = document.querySelector("[data-testid='document-revision']") as HTMLElement;
          const before = el.textContent;
          watch(el, { childList: true, characterData: true, subtree: true }, () => el.textContent !== before);
          (
            document.querySelector(
              `[data-testid='panel-${chartId}'] [data-testid='add-threshold']`,
            ) as HTMLElement
          ).click();
        } else {
          const el = document.querySelector(`[data-testid='panel-${noteId}']`) as HTMLElement;
          const text = `edit ${n}`;
          watch(el, { childList: true, characterData: true, subtree: true }, () =>
            el.textContent!.includes(text),
          );
          void w.__nearesis.applyOps([
            { op: "updatePanel", panelId: noteId, panel: { ...(note as object), note: text } },
          ]);
        }
      }),
    [kind, ws.chartId, ws.noteId, ws.note, i] as [string, string, string, Record<string, unknown>, number],
  );

const cmdCount = (page: Page) =>
  page.evaluate(() => (window as unknown as { __perf: { cmds: unknown[] } }).__perf.cmds.length);
const cmdAt = (page: Page, idx: number) =>
  page.evaluate(
    (i) => (window as unknown as { __perf: { cmds: Array<{ ms: number; status: number }> } }).__perf.cmds[i]!,
    idx,
  );

it("PERF05: cached workspace load p95 < 1.5 s and mutation acknowledgement p95 < 250 ms with 20 concurrent users", async () => {
  if (!g.ok && !DRYRUN) {
    observe({ testId: "PERF05", observed: "not executed", blocked: g.reason });
    return;
  }
  if (blocked || !stack) {
    observe({
      testId: "PERF05",
      observed: "not executed: stack unavailable",
      blocked: blocked ?? "no stack",
    });
    return;
  }
  const st = stack;
  const { loadScenario } = await import("../../apps/web/src/fixtures/scenarios.ts");
  const kh = await import("../../apps/web/test/acceptance/kernel-harness.ts");
  const base = (loadScenario("baseline").document as { panels: Array<Record<string, unknown>> }).panels;
  const chartIdx = base.findIndex((p) => p.kind === "timeSeries");
  const noteIdx = base.findIndex((p) => p.kind === "note");
  expect(chartIdx).toBeGreaterThanOrEqual(0);
  expect(noteIdx).toBeGreaterThanOrEqual(0);

  // ---- fixture: 20 workspaces, 4..12 panels each, panel 0 a chart and panel 1 a note
  const specs: Array<{ panels: Array<Record<string, unknown>>; expected: Ws }> = [];
  for (let w = 0; w < th.workspaces!; w++) {
    const n = 4 + (w % 9);
    const ids: string[] = [];
    const panels = Array.from({ length: n }, (_, i) => {
      const p = base[i === 0 ? chartIdx : i === 1 ? noteIdx : i % base.length]!;
      const panelId = `00000000-0000-4000-8000-${(0x6000 + w * 16 + i).toString(16).padStart(12, "0")}`;
      ids.push(panelId);
      return {
        ...p,
        panelId,
        title: `${String(p.title)} #${w}.${i}`,
        layout: { x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 },
      };
    });
    specs.push({
      panels,
      expected: { workspaceId: "", chartId: ids[0]!, noteId: ids[1]!, note: panels[1]!, panels: n },
    });
  }
  const fixtureHash = sha256Text(JSON.stringify(FIXTURE_SPEC) + JSON.stringify(specs.map((s) => s.panels)));
  if (DRYRUN) process.stderr.write(`FIXTUREHASH PERF05 ${fixtureHash}\n`);
  if (g.ok) expect(referenceB().fixtures.PERF05).toBe(fixtureHash);
  const wss: Ws[] = [];
  for (const [i, s] of specs.entries()) {
    const { workspaceId } = await kh.seedWorkspace(st as never, `u${i}`, s.panels as never);
    wss.push({ ...s.expected, workspaceId });
  }
  // One dev login per user (the endpoint allows 20 per minute); every later context of a user reuses that session cookie.
  const storages = [];
  for (let i = 0; i < th.concurrentUsers!; i++) {
    const login = await kh.loggedIn(st.browser, st as never, `u${i}`);
    storages.push(await login.storageState());
    await login.close();
  }
  const newCtx = (i: number) =>
    st.browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      storageState: storages[i]!,
    });
  const users = await Promise.all(wss.map((_, i) => newCtx(i)));
  const U = th.concurrentUsers!;
  expect(users.length).toBe(U);

  // ---- cached load: warm-up (one load each), then loadsPerWorkspace loads by 20 concurrent users
  await Promise.all(users.map((c, i) => measureLoad(c, st.base, wss[i]!)));
  const warm: LoadSample[] = [];
  await Promise.all(
    users.map(async (c, i) => {
      for (
        let n = 0;
        n < (DRYRUN && process.env.PERF_LOADS ? Number(process.env.PERF_LOADS) : th.loadsPerWorkspace!);
        n++
      )
        warm.push(await measureLoad(c, st.base, wss[i]!));
    }),
  );
  const warmMs = warm.map((x) => x.ms);
  const loadStats = stats(warmMs);
  const lcpStats = stats(warm.map((x) => x.lcp));
  const ttfbStats = stats(warm.flatMap((x) => x.ttfb));
  const loadErrors = warm.flatMap((x) => x.errors);

  // ---- cold load: cache flush = web server restart + fresh contexts; reported separately
  await Promise.all(users.map((c) => c.close()));
  await st.restartWeb();
  const coldUsers = await Promise.all(wss.map((_, i) => newCtx(i)));
  const cold = await Promise.all(coldUsers.map((c, i) => measureLoad(c, st.base, wss[i]!)));
  await Promise.all(coldUsers.map((c) => c.close()));
  const coldStats = stats(cold.map((x) => x.ms));
  const coldSkeleton = cold.filter((x) => x.skeleton).length;

  // ---- mutations: 20 users x 25, rotating move / marker / note, all in flight concurrently
  const per = Math.round(th.mutations! / U);
  const mctx = await Promise.all(wss.map((_, i) => newCtx(i)));
  const pages = await Promise.all(mctx.map((c, i) => openWorkspace(c, st.base, wss[i]!)));
  const acks: Record<string, number[]> = { move: [], marker: [], note: [] };
  const confirms: number[] = [];
  const lost: string[] = [];
  const issued = wss.map(() => ({ move: 0, marker: 0, note: 0 }));
  await Promise.all(
    pages.map(async (page, u) => {
      for (let i = 0; i < per; i++) {
        const kind = (["move", "marker", "note"] as const)[i % 3]!;
        const before = await cmdCount(page);
        const rev = await page.evaluate(
          () => (window as unknown as { __nearesis: { doc: { revision: number } } }).__nearesis.doc.revision,
        );
        const ms = await ackIn(page, kind, wss[u]!, issued[u]![kind]);
        issued[u]![kind]++;
        if (ms < 0) lost.push(`${u}:${i}:${kind}`);
        else acks[kind]!.push(ms);
        await page
          .waitForFunction(
            (r) =>
              (window as unknown as { __nearesis: { doc: { revision: number } } }).__nearesis.doc.revision >
              r,
            rev,
            { timeout: 15_000 },
          )
          .catch(() => lost.push(`${u}:${i}:${kind}:noconfirm`));
        if ((await cmdCount(page)) > before) {
          const c = await cmdAt(page, before);
          if (c.status < 300) confirms.push(c.ms);
        }
      }
    }),
  );
  const mutErrors = (
    await Promise.all(
      pages.map((p) =>
        p.evaluate(() => (window as unknown as { __perf: { errors: string[] } }).__perf.errors),
      ),
    )
  ).flat();
  const allAcks = Object.values(acks).flat();
  const ackStats = stats(allAcks);

  // ---- no mutation lost or duplicated: every workspace's server state equals the issued edits, events gap-free
  const recon: Array<Record<string, unknown>> = [];
  for (let u = 0; u < wss.length; u++) {
    const w = wss[u]!;
    const s = await st.session(`u${u}`);
    const doc = (await st.kernel.canvas.get(s, w.workspaceId)) as {
      panels: Array<{ panelId: string; layout: { y: number }; note?: string }>;
      markers: unknown[];
    };
    const chart = doc.panels.find((p) => p.panelId === w.chartId)!;
    const note = doc.panels.find((p) => p.panelId === w.noteId)!;
    const events = (
      await st.db.admin.query("SELECT seq FROM workspace_events WHERE workspace_id=$1 ORDER BY seq", [
        w.workspaceId,
      ])
    ).rows.map((r) => Number(r.seq));
    const expectEvents = 2 + per; // workspace creation + seed patch + one command per mutation
    recon.push({
      u,
      markers: doc.markers.length,
      expectMarkers: issued[u]!.marker,
      y: chart.layout.y,
      expectY: issued[u]!.move % 2,
      note: note.note,
      expectNote: `edit ${issued[u]!.note - 1}`,
      events: events.length,
      expectEvents,
      gaps: events.filter((e, i) => e !== i + 1).length,
    });
  }
  const mismatches = recon.filter(
    (r) =>
      r.markers !== r.expectMarkers ||
      r.y !== r.expectY ||
      r.note !== r.expectNote ||
      r.events !== r.expectEvents ||
      r.gaps !== 0,
  );
  await Promise.all(mctx.map((c) => c.close()));

  // ---- negative control: 400 ms added to every command response must FAIL the acknowledgement judgement
  const cctx = await newCtx(0);
  const cpage2 = await openWorkspace(cctx, st.base, wss[0]!);
  await cpage2.route("**/api/k/**", async (route) => {
    if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  const ctl: number[] = [];
  for (let i = 0; i < 30; i++) {
    const ms = await ackIn(cpage2, i % 2 ? "marker" : "move", wss[0]!, 1000 + i);
    if (ms >= 0) ctl.push(ms);
    await new Promise((r) => setTimeout(r, 100));
  }
  await cctx.close();
  const controlFails = !ackPasses(ctl, th.ackP95Ms!);

  const realAckPasses = ackPasses(allAcks, th.ackP95Ms!);
  const skeletonRate = `${coldSkeleton}/${cold.length}`;
  if (DRYRUN) {
    process.stderr.write(
      "DRYRUN " +
        JSON.stringify({
          load: loadStats,
          lcp: lcpStats,
          ttfb: ttfbStats,
          cold: coldStats,
          skeleton: skeletonRate,
          ack: ackStats,
          byKind: Object.fromEntries(Object.entries(acks).map(([k, v]) => [k, stats(v)])),
          confirm: stats(confirms),
          lost,
          mutErrors: mutErrors.slice(0, 5),
          loadErrors: loadErrors.slice(0, 5),
          mismatches: mismatches.slice(0, 3),
          control: stats(ctl),
          controlFails,
        }) +
        "\n",
    );
  }
  expect(loadErrors).toEqual([]);
  expect(mutErrors).toEqual([]);
  expect(lost).toEqual([]);
  expect(mismatches).toEqual([]);
  expect(allAcks.length).toBe(th.mutations);
  expect(cold.length).toBe(U);
  expect(coldSkeleton).toBe(cold.length); // skeleton visible for every cold load
  expect(controlFails).toBe(true); // the 400 ms build is detected
  if (DRYRUN) return;
  expect(warmMs.length).toBe(th.workspaces! * th.loadsPerWorkspace!);
  expect(loadStats.p95).toBeLessThan(th.cachedLoadP95Ms!);
  expect(realAckPasses).toBe(true);

  observe({
    testId: "PERF05",
    observed: `${th.workspaces} workspaces (4-12 panels) x ${th.loadsPerWorkspace} loads by ${U} concurrent users (${warmMs.length} cached loads, load = navigation to all panels settled): p50 ${loadStats.p50} ms, p95 ${loadStats.p95} ms, p99 ${loadStats.p99} ms (bound p95 < ${th.cachedLoadP95Ms} ms); LCP p95 ${lcpStats.p95} ms; API time-to-first-byte p95 ${ttfbStats.p95} ms. Cold (web restart, n=${cold.length}, reported only): p50 ${coldStats.p50} ms, p95 ${coldStats.p95} ms, skeleton visible in ${skeletonRate}. ${allAcks.length} mutations (move/marker/note ${acks.move!.length}/${acks.marker!.length}/${acks.note!.length}): client acknowledgement p50 ${ackStats.p50} ms, p95 ${ackStats.p95} ms, p99 ${ackStats.p99} ms (bound p95 < ${th.ackP95Ms} ms); server confirmation p95 ${stats(confirms).p95} ms; lost 0, duplicated 0, events gap-free, final state equals issued edits in all ${wss.length} workspaces; errors 0. Negative control (+400 ms on every command): ack p95 ${stats(ctl).p95} ms, judged FAIL as required`,
    fixtureHash,
    evidence: {
      ...evidenceBase(g, {
        dataset: { id: "perf05 fixture spec", sha256: fixtureHash },
        concurrency: { users: U, loadsPerWorkspace: th.loadsPerWorkspace, mutationsPerUser: per },
        cacheState: "cached judged (warm-up first); cold reported (web server restart, fresh contexts)",
      }),
      browser: {
        chromium: st.browser.version(),
        headless: true,
        viewport: FIXTURE_SPEC.viewport,
        build: "production",
        buildId: st.buildId,
      },
      load: { stats: loadStats, histogram: histogram(warmMs), rawMs: warmMs.map((x) => Math.round(x)) },
      lcp: lcpStats,
      serverTtfb: ttfbStats,
      cold: { stats: coldStats, histogram: histogram(cold.map((x) => x.ms)), skeletonVisible: skeletonRate },
      acknowledgement: {
        stats: ackStats,
        histogram: histogram(allAcks),
        byKind: Object.fromEntries(Object.entries(acks).map(([k, v]) => [k, stats(v)])),
        rawMs: allAcks.map((x) => Math.round(x)),
      },
      serverConfirmationMs: stats(confirms),
      reconciliation: { workspaces: recon.length, mismatches: mismatches.length },
      negativeControl: { delayMs: 400, ack: stats(ctl), judgedFail: controlFails },
      errors: { load: loadErrors.length, mutations: mutErrors.length },
    },
  });
}, 1_800_000);

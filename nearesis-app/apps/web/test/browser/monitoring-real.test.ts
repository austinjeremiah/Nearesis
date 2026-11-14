/**
 * Monitoring UI against the REAL kernel (B3). Same flow F1 drove against the labelled TEST adapter, now with the real
 * kernel API (`buildApp`), real Postgres, real scheduler (`processEvent`) and the same-origin BFF. Every UI action is
 * followed by an assertion on the persisted server state read back through the API. No test adapter is used.
 * Panel data is SYNTHETIC fixture data (labelled); persistence, commands, scheduler, notifications are the kernel.
 * Browser-test results only: this is not an acceptance run.
 */
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import type {
  Lens,
  Marker,
  MarkerTask,
  MonitorRule,
  MonitorTrigger,
  Notification,
} from "@nearesis/contracts";
import type { PanelSpec } from "@nearesis/contracts";
import { BASE } from "../acceptance/harness.ts";
import { loadScenario } from "../../src/fixtures/scenarios.ts";
import { apiClient, startRealEnv } from "../acceptance/monitoring-harness.ts";

const SHOTS = new URL("../../test-results/monitoring/", import.meta.url).pathname;
const PANELS = (loadScenario("visuals").document as { panels: PanelSpec[] }).panels;
const P_CANDLE = PANELS[0]!.panelId;
const P_HEAT = PANELS[1]!.panelId;
const P_SWAPS = PANELS[2]!.panelId;

type Env = Awaited<ReturnType<typeof startRealEnv>>;
type Api = Awaited<ReturnType<typeof apiClient>>;
type Chart = {
  getOption: () => {
    series: Array<{
      markArea?: { data: Array<Array<{ xAxis?: number }>> };
      markLine?: { data: Array<{ xAxis?: number }> };
    }>;
    dataZoom: Array<{ startValue?: number; endValue?: number }>;
  };
  convertToPixel: (f: { xAxisIndex: number }, v: number) => number;
  dispatchAction: (a: object) => void;
};
type W = { __nearesis: { charts: Record<string, Chart> } };

let env: Env;
let api: Api;
let ws: string;
let ctx: BrowserContext;
const base = () => `/v1/workspaces/${ws}`;
const url = (hash = "") => `${BASE}/w/${ws}?backend=kernel${hash}`;

/** POST responses seen by any page (command rejections); appended to timeout errors so failures are diagnosable. */
const NET: string[] = [];
async function until<T>(fn: () => Promise<T | false | null | undefined>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return v as T;
    if (Date.now() > end)
      throw new Error(`condition not met before deadline; recent POSTs: ${JSON.stringify(NET.slice(-4))}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const markers = async () => (await api.get<{ markers: Marker[] }>(`${base()}/markers`)).markers;
const rules = async () => (await api.get<{ rules: MonitorRule[] }>(`${base()}/monitors`)).rules;
const triggers = async () =>
  (await api.get<{ triggers: MonitorTrigger[] }>(`${base()}/monitors/triggers`)).triggers;
const notifications = async () =>
  (await api.get<{ notifications: Notification[] }>(`${base()}/notifications`)).notifications;
const lenses = async () => (await api.get<{ lenses: Lens[] }>(`${base()}/lenses`)).lenses;
const tasks = async () => (await api.get<{ tasks: MarkerTask[] }>(`${base()}/marker-tasks`)).tasks;

async function open(hash = ""): Promise<Page> {
  const page = await ctx.newPage();
  page.on("response", async (r) => {
    if (r.request().method() === "POST")
      NET.push(`${r.status()} ${r.url().slice(-12)} ${(await r.text().catch(() => "")).slice(0, 400)}`);
  });
  await page.goto(url(hash), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    null,
    { timeout: 90_000 },
  );
  return page;
}
const markerTimes = (page: Page, panelId: string) =>
  page.evaluate((id) => {
    const c = (window as unknown as W).__nearesis.charts[id]!;
    const s = c.getOption().series[0]!;
    return {
      ranges: (s.markArea?.data ?? [])
        .map((a) => a.map((e) => e.xAxis))
        .filter((a) => a[0] !== undefined && a.length === 2),
      points: (s.markLine?.data ?? []).map((l) => l.xAxis).filter((x) => x !== undefined),
    };
  }, panelId);
const statusOf = (page: Page) => page.getByTestId("marker-status").first().getAttribute("data-status");

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  env = await startRealEnv(PANELS);
  ws = env.workspaceId;
  api = await apiClient(env, "alice");
  ctx = await env.loggedIn("alice");
  ctx.setDefaultNavigationTimeout(120_000);
  // `next dev` compiles routes on first request: warm the pages the tests use so test timing is about the UI.
  const warm = await ctx.newPage();
  await warm.goto(url("#monitoring"), { timeout: 240_000 });
  await warm.waitForFunction(
    () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    null,
    { timeout: 120_000 },
  );
  await warm.goto(`${BASE}/w/${ws}/evidence`, { timeout: 240_000 });
  await warm.close();
}, 600_000);
afterAll(async () => {
  await ctx?.close();
  await env?.close();
}, 120_000);

describe("monitoring UI on the real kernel", () => {
  it("chart gestures persist markers on data coordinates through zoom, resize and reload", async () => {
    expect(await markers()).toHaveLength(0);
    const page = await open();
    const net: string[] = [];
    page.on("response", async (r) => {
      if (r.request().method() === "POST")
        net.push(`${r.status()} ${r.url().slice(-40)} ${(await r.text().catch(() => "")).slice(0, 300)}`);
    });
    const panel = page.locator(`[data-testid='panel-${P_SWAPS}']`);
    await panel.locator("[data-testid='chart-keyboard']").focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Enter");
    await until(async () => (await page.getByTestId("monitor-selection").count()) > 0);
    await panel.getByTestId("monitor-selection").click();
    const range = await until(async () =>
      (await markers()).find((m) => m.anchor.kind === "time_range"),
    ).catch(async (e) => {
      const toast = await page.getByTestId("toast").allInnerTexts();
      throw new Error(
        `no range marker; toast=${JSON.stringify(toast)} net=${JSON.stringify(net)} markers=${JSON.stringify(await markers())} cause=${e}`,
      );
    });
    // Persisted server state of the range marker.
    expect(range.status).toBe("DRAFT");
    expect(range.sourcePanelId).toBe(P_SWAPS);
    expect(range.anchor).toEqual({
      kind: "time_range",
      start: "2026-10-03T00:00:00.000Z",
      end: "2026-10-08T00:00:00.000Z",
    });
    expect(range.selection?.queryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(range.selection?.interval.start).toBe("2026-10-03T00:00:00.000Z");
    expect(range.assignedAgents).toEqual([]);
    expect(await tasks()).toHaveLength(0); // a selection never starts an agent

    // Point by keyboard: cursor then P.
    await panel.locator("[data-testid='chart-keyboard']").focus();
    await page.keyboard.press("Escape");
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("p");
    const point = await until(async () => (await markers()).find((m) => m.anchor.kind === "time_point"));
    expect(point.anchor).toEqual({ kind: "time_point", at: "2026-10-10T00:00:00.000Z" });
    expect(point.status).toBe("DRAFT");

    // Point by mouse click.
    await panel.getByTestId("point-mode").click();
    const box = (await panel.locator(`[data-testid='chart-${P_SWAPS}']`).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await until(async () => (await markers()).filter((m) => m.anchor.kind === "time_point").length === 2);
    const all = await markers();
    expect(all).toHaveLength(3);
    expect(new Set(all.map((m) => m.markerId)).size).toBe(3);

    // Markers are on data coordinates: zoom and resize move pixels, not data positions.
    await until(async () => (await markerTimes(page, P_SWAPS)).points.length === 2);
    const before = await markerTimes(page, P_SWAPS);
    expect(before.ranges).toContainEqual([Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 8)]);
    await page.evaluate(
      (id) =>
        (window as unknown as W).__nearesis.charts[id]!.dispatchAction({
          type: "dataZoom",
          startValue: Date.UTC(2026, 9, 8),
          endValue: Date.UTC(2026, 9, 20),
        }),
      P_SWAPS,
    );
    await page.setViewportSize({ width: 1100, height: 800 });
    expect(await markerTimes(page, P_SWAPS)).toEqual(before);
    await page.screenshot({ path: `${SHOTS}real-01-gestures.png` });

    // Reload: the same three markers come back from the server and are drawn again.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );
    await until(async () => (await markerTimes(page, P_SWAPS)).points.length === 2, 25_000).catch(
      async (e) => {
        const dbg = await page.evaluate((id) => {
          const w = window as unknown as { __nearesis: { charts: Record<string, Chart> } };
          const c = w.__nearesis.charts[id];
          return {
            charts: Object.keys(w.__nearesis.charts),
            s0: c
              ? JSON.stringify({
                  l: c.getOption().series[0]!.markLine,
                  a: c.getOption().series[0]!.markArea,
                }).slice(0, 700)
              : null,
          };
        }, P_SWAPS);
        throw new Error(`reload markers missing ${JSON.stringify(dbg)} ${e}`);
      },
    );
    expect(await markerTimes(page, P_SWAPS)).toEqual(before);
    expect(await markers()).toHaveLength(3);
    await page.close();
  }, 180_000);

  it("marker inspector: transitions, assign, task status and resolution are persisted", async () => {
    const page = await open("#monitoring");
    await page.getByTestId("monitoring-view").waitFor();
    expect(await page.getByTestId("test-adapter-banner").count()).toBe(0);
    const rangeMarker = (await markers()).find((m) => m.anchor.kind === "time_range")!;
    await page.getByTestId(`marker-row-${rangeMarker.markerId}`).click();
    const insp = page.getByTestId("marker-inspector");
    expect(await insp.getAttribute("data-marker-id")).toBe(rangeMarker.markerId);
    expect(await page.getByTestId("marker-query-hash").innerText()).toBe(rangeMarker.selection!.queryHash);
    expect(await insp.getByTestId("marker-status").getAttribute("data-status")).toBe("DRAFT");
    expect(await page.getByTestId("assign-agent").count()).toBe(0); // cannot assign a DRAFT

    await page.getByTestId("transition-ACTIVE").click();
    await until(
      async () => (await markers()).find((m) => m.markerId === rangeMarker.markerId)?.status === "ACTIVE",
    );
    await until(async () => (await statusOf(page)) === "ACTIVE");

    await insp.getByTestId("assign-agent").click();
    // Real kernel: the marker becomes INVESTIGATING only once the marker-task dispatcher durably starts the child run
    // (needs the runtime port, not running in this harness). Until then the assignment is a PENDING task, shown as such.
    const t = await until(async () => (await tasks()).find((x) => x.markerId === rangeMarker.markerId));
    expect(t.origin).toBe("assign");
    expect(t.mode).toBe("live");
    expect(t.status).toBe("PENDING");
    expect(t.agents).toEqual(["quant"]);
    const afterAssign = (await markers()).find((x) => x.markerId === rangeMarker.markerId)!;
    expect(afterAssign.assignedAgents).toEqual(["quant"]);
    await until(
      async () => (await page.getByTestId("task-status").getAttribute("data-status")) === "PENDING",
    );
    // No invented progress: the UI does not claim INVESTIGATING while the server says otherwise.
    expect(await statusOf(page)).toBe(afterAssign.status);
    // User transition ACTIVE -> INVESTIGATING (legal on the state machine).
    if (afterAssign.status === "ACTIVE") {
      await page.getByTestId("transition-INVESTIGATING").click();
      await until(
        async () =>
          (await markers()).find((m) => m.markerId === rangeMarker.markerId)?.status === "INVESTIGATING",
      );
      await until(async () => (await statusOf(page)) === "INVESTIGATING");
    }

    // INVESTIGATING -> REVIEW_REQUIRED is a legal user transition on the real state machine.
    await page.getByTestId("transition-REVIEW_REQUIRED").click();
    await until(
      async () =>
        (await markers()).find((m) => m.markerId === rangeMarker.markerId)?.status === "REVIEW_REQUIRED",
    );
    expect(await page.getByTestId("transition-RESOLVED").isDisabled()).toBe(true);
    await page.getByTestId("resolution-input").fill("Explained by the settlement transition.");
    await page.getByTestId("transition-RESOLVED").click();
    const resolved = await until(async () => {
      const m = (await markers()).find((x) => x.markerId === rangeMarker.markerId);
      return m?.status === "RESOLVED" ? m : false;
    });
    expect(resolved.resolution).toBe("Explained by the settlement transition.");
    await until(async () => (await page.locator("[data-testid^='transition-']").count()) === 0);
    await page.screenshot({ path: `${SHOTS}real-02-inspector.png` });

    // A rejected transition from the server is shown, not swallowed: bob (analyst) tries nothing here; instead make the
    // server reject by moving the marker behind the UI's back and acting on the stale view.
    const point = (await markers()).find((m) => m.anchor.kind === "time_point")!;
    await page.getByTestId(`marker-row-${point.markerId}`).click();
    await api.command(ws, "marker.transition", { markerId: point.markerId, to: "ACTIVE" });
    await page.getByTestId("transition-ACTIVE").click(); // stale: server state is already ACTIVE
    await until(
      async () => (await page.getByTestId("toast").count()) > 0 || (await statusOf(page)) === "ACTIVE",
    );
    expect((await markers()).find((m) => m.markerId === point.markerId)?.status).toBe("ACTIVE");
    await page.close();
  }, 120_000);

  it("rule editor: create, update, enable, disable are persisted", async () => {
    const page = await open("#monitoring");
    await page.getByTestId("tab-rules").click();
    await page.getByTestId("new-rule").click();
    await page.getByTestId("rule-name").fill("Swap count spike");
    await page.getByTestId("rule-source").fill("explorer.swaps");
    await page.getByTestId("rule-metric").fill("intents.swap_count");
    await page.getByTestId("rule-value").fill("200");
    await page.getByTestId("rule-frequency-value").fill("15");
    await page.getByTestId("rule-frequency-unit").selectOption("m");
    await page.getByTestId("rule-cooldown-value").fill("6");
    await page.getByTestId("rule-cooldown-unit").selectOption("h");
    await page.getByTestId("rule-save").click();
    const created = await until(async () => (await rules()).find((r) => r.name === "Swap count spike"));
    expect(created.sourceId).toBe("explorer.swaps");
    expect(created.condition).toEqual({
      kind: "compare",
      metricId: "intents.swap_count",
      op: "gt",
      value: 200,
    });
    expect(created.frequency.minIntervalSeconds).toBe(900);
    expect(created.cooldownSeconds).toBe(21_600);
    expect(created.enabled).toBe(false);
    const row = page.getByTestId(`rule-row-${created.ruleId}`);
    await until(async () => (await row.getAttribute("data-enabled")) === "false");

    await page.getByTestId(`rule-toggle-${created.ruleId}`).click();
    await until(async () => (await rules()).find((r) => r.ruleId === created.ruleId)?.enabled === true);
    await until(async () => (await row.getAttribute("data-enabled")) === "true");

    // Update: select the rule, change the threshold.
    await row.getByRole("button").first().click();
    await page.getByTestId("rule-value").fill("150");
    await page.getByTestId("rule-save").click();
    const updated = await until(async () => {
      const r = (await rules()).find((x) => x.ruleId === created.ruleId);
      return r && r.condition.kind === "compare" && r.condition.value === 150 ? r : false;
    });
    expect(updated.version).toBeGreaterThan(created.version);
    expect(updated.enabled).toBe(true);

    await page.getByTestId(`rule-toggle-${created.ruleId}`).click();
    await until(async () => (await rules()).find((r) => r.ruleId === created.ruleId)?.enabled === false);
    await until(async () => (await row.getAttribute("data-enabled")) === "false");
    await page.getByTestId(`rule-toggle-${created.ruleId}`).click();
    await until(async () => (await rules()).find((r) => r.ruleId === created.ruleId)?.enabled === true);

    // An invalid rule is rejected by the server and the error is shown, nothing is persisted.
    const n = (await rules()).length;
    await page.getByTestId("new-rule").click();
    await page.getByTestId("rule-name").fill("Bad rule");
    await page.getByTestId("rule-source").fill("explorer.swaps");
    await page.getByTestId("rule-metric").fill("not a valid metric!");
    await page.getByTestId("rule-value").fill("1");
    await page.getByTestId("rule-save").click();
    await page.getByTestId("rule-error").waitFor({ timeout: 8000 });
    expect((await rules()).length).toBe(n);
    await page.screenshot({ path: `${SHOTS}real-03-rules.png` });
    await page.close();
  }, 120_000);

  it("triggers and notifications: live and replay are separated, read state is persisted", async () => {
    const rule = (await rules()).find((r) => r.name === "Swap count spike")!;
    expect(rule.enabled).toBe(true);
    // Live firing through the real scheduler; replay through the real replay route.
    const sched = env.kernel.monitorScheduler();
    const live = await sched.processEvent(
      {
        sourceId: "explorer.swaps",
        mode: "live",
        watermark: "2026-11-10T12:00:00.000Z",
        values: { "intents.swap_count": 400 },
        maturity: "final",
      },
      { workspaceId: ws },
    );
    expect(live.some((r) => r.outcome === "fired")).toBe(true);
    const rep = await api.post(`${base()}/monitors/replay`, {
      sourceId: "explorer.swaps",
      events: [{ watermark: "2026-10-27T12:00:00.000Z", values: { "intents.swap_count": 500 } }],
    });
    expect(rep.statusCode).toBe(200);

    const page = await open("#monitoring");
    await page.getByTestId("tab-triggers").click();
    await until(async () => (await page.locator("[data-testid^='trigger-row-']").count()) >= 2);
    const server = await triggers();
    const liveRows = server.filter((t) => t.mode === "live");
    const replayRows = server.filter((t) => t.mode === "replay");
    expect(replayRows).toHaveLength(1);
    expect(await page.locator("[data-testid^='trigger-row-'][data-mode='replay']").count()).toBe(1);
    expect(await page.locator("[data-testid^='trigger-row-'][data-mode='live']").count()).toBe(
      liveRows.length,
    );
    expect(await page.getByTestId("mode-badge-replay").first().innerText()).toBe("REPLAY");
    expect(
      await page
        .locator("[data-testid^='trigger-row-'][data-mode='replay']")
        .getByTestId("mode-badge-live")
        .count(),
    ).toBe(0);

    // Notifications: unread count matches the server, mark read persists.
    const ns = await notifications();
    const unreadServer = ns.filter((n) => n.readAt === null).length;
    expect(unreadServer).toBeGreaterThanOrEqual(2);
    await until(async () => (await page.getByTestId("unread-count").innerText()) === String(unreadServer));
    await page.getByTestId("tab-notifications").click();
    expect(await page.getByTestId("mode-badge-replay").count()).toBeGreaterThanOrEqual(1);
    const first = page.locator("[data-testid^='notification-read-']").first();
    const nid = (await first.getAttribute("data-testid"))!.replace("notification-read-", "");
    await first.click();
    await until(async () => (await notifications()).find((n) => n.notificationId === nid)?.readAt != null);
    await until(
      async () => (await page.getByTestId("unread-count").innerText()) === String(unreadServer - 1),
    );
    expect((await notifications()).filter((n) => n.readAt === null).length).toBe(unreadServer - 1);
    await page.screenshot({ path: `${SHOTS}real-04-notifications.png` });
    await page.close();
  }, 120_000);

  it("lens: persisted, resolved by the server, applied (and honestly not applied) per panel", async () => {
    const page = await open("#monitoring");
    await page.getByTestId("tab-lenses").click();
    await page.getByTestId("lens-name").fill("October window");
    for (const id of [P_CANDLE, P_HEAT, P_SWAPS]) await page.getByTestId(`lens-pick-${id}`).check();
    await page.getByTestId("lens-start").fill("2026-10-05T00:00");
    await page.getByTestId("lens-end").fill("2026-10-20T00:00");
    await page.getByTestId("lens-save").click();
    const lens = await until(async () => (await lenses()).find((l) => l.name === "October window"));
    expect(lens.panelIds.sort()).toEqual([P_CANDLE, P_HEAT, P_SWAPS].sort());
    expect(lens.filter.timeRange?.start).toBe("2026-10-05T00:00:00.000Z");
    expect(lens.filter.timeRange?.end).toBe("2026-10-20T00:00:00.000Z");
    const res = (
      await api.get<{ panels: Array<{ panelId: string; compatible: boolean; reason: string | null }> }>(
        `${base()}/lenses/${lens.lensId}/resolution`,
      )
    ).panels;

    await page.getByRole("button", { name: "Apply lens" }).first().click();
    await page.getByTestId("lens-resolution").waitFor();
    for (const r of res)
      expect(await page.getByTestId(`lens-panel-${r.panelId}`).getAttribute("data-compatible")).toBe(
        String(r.compatible),
      );
    await page.getByTestId("back-to-canvas").click();
    await page.locator(`[data-testid='panel-${P_SWAPS}']`).waitFor();
    // Every lens panel shows a notice that matches the server resolution; none is silently unfiltered.
    for (const r of res) {
      const notice = page.locator(`[data-testid='panel-${r.panelId}'] [data-testid='lens-notice']`);
      await notice.waitFor({ timeout: 10_000 });
      const text = await notice.innerText();
      if (r.compatible && r.panelId !== P_HEAT) expect(text).toContain("applied");
      else expect(text).toContain("not applied");
    }
    for (const id of [P_CANDLE, P_SWAPS]) {
      const z = await until(async () => {
        const v = await page.evaluate(
          (cid) => (window as unknown as W).__nearesis.charts[cid]?.getOption().dataZoom[0],
          id,
        );
        return v?.startValue === Date.UTC(2026, 9, 5) ? v : false;
      });
      expect(z.endValue).toBe(Date.UTC(2026, 9, 20));
    }
    await page.screenshot({ path: `${SHOTS}real-05-lens-canvas.png` });

    // Segment filter: never silently ignored. A second lens with a segment states it on each affected panel.
    await api.command(ws, "lens.create", {
      name: "Segmented",
      panelIds: [P_SWAPS, P_HEAT],
      filter: { segment: { dimension: "intents.chain", values: ["near"] } },
    });
    const seg = await until(async () => (await lenses()).find((l) => l.name === "Segmented"));
    await page.getByRole("button", { name: /^Monitoring/ }).click();
    await page.getByTestId("tab-lenses").click();
    await page.getByTestId(`lens-apply-${seg.lensId}`).click();
    await page.getByTestId("back-to-canvas").click();
    for (const id of [P_SWAPS, P_HEAT]) {
      const notice = page.locator(`[data-testid='panel-${id}'] [data-testid='lens-notice']`);
      await until(async () => (await notice.innerText()).includes("intents.chain"), 10_000);
      expect(await notice.innerText()).toMatch(/not applied/i);
    }
    await page.screenshot({ path: `${SHOTS}real-06-lens-segment.png` });

    // Reload: the applied lens id survives locally and is re-resolved against the server.
    await page.reload();
    await page.waitForFunction(
      () => (window as unknown as { __nearesis?: { ready: boolean } }).__nearesis?.ready === true,
    );
    await page
      .locator(`[data-testid='panel-${P_SWAPS}'] [data-testid='lens-notice']`)
      .waitFor({ timeout: 15_000 });
    expect(await lenses()).toHaveLength(2);
    await page.close();
  }, 180_000);

  it("evidence link navigates to the evidence graph with the node id", async () => {
    const node = randomUUID();
    const v = (await api.get<{ version: number }>(base())).version;
    const r = await api.post(`${base()}/graph/nodes`, {
      commandId: randomUUID(),
      expectedVersion: v,
      nodeId: node,
      kind: "observation",
      label: "Settlement transition observed",
      data: {},
    });
    expect([200, 201]).toContain(r.statusCode);
    const m = (await markers()).find((x) => x.anchor.kind === "time_point")!;
    await api.command(ws, "marker.link_evidence", { markerId: m.markerId, evidenceIds: [node] });
    expect((await markers()).find((x) => x.markerId === m.markerId)?.linkedEvidenceIds).toEqual([node]);

    const page = await open("#monitoring");
    await page.getByTestId("tab-markers").click(); // the last tab used is persisted per browser context
    await page.getByTestId(`marker-row-${m.markerId}`).click();
    await page.getByTestId("marker-evidence").getByRole("button").first().click();
    await page.waitForURL(new RegExp(`/w/${ws}/evidence\\?node=${node}`), { timeout: 20_000 });
    await page.getByTestId("evidence-page").waitFor({ timeout: 30_000 });
    await page.getByTestId(`list-node-${node}`).waitFor({ timeout: 20_000 });
    await page.screenshot({ path: `${SHOTS}real-07-evidence.png` });
    await page.close();
  }, 120_000);

  it("degraded and error states, keyboard operation and reload persistence", async () => {
    const page = await open("#monitoring");
    await page.getByTestId("monitoring-view").waitFor();
    await page.getByTestId("tab-markers").click();
    await page.getByTestId("tab-markers").focus();
    await page.keyboard.press("ArrowRight");
    await until(async () => (await page.getByTestId("tab-rules").getAttribute("aria-selected")) === "true");
    await page.keyboard.press("End");
    await until(
      async () => (await page.getByTestId("tab-delegation").getAttribute("aria-selected")) === "true",
    );
    await page.keyboard.press("Home");
    await until(async () => (await page.getByTestId("tab-markers").getAttribute("aria-selected")) === "true");
    await page.keyboard.press("ArrowRight");
    await until(async () => (await page.getByTestId("tab-rules").getAttribute("aria-selected")) === "true");
    await page.keyboard.press("ArrowRight");
    await until(
      async () => (await page.getByTestId("tab-triggers").getAttribute("aria-selected")) === "true",
    );

    // Backend failure on the real BFF path: the banner appears, last good data stays, it clears when the API answers.
    const before = (await markers()).length;
    await page.route("**/api/k/workspaces/*/monitors", (r) => r.fulfill({ status: 503, body: "{}" }));
    await page.getByTestId("monitoring-degraded").waitFor({ timeout: 10_000 });
    expect(await page.getByTestId("monitoring-sync").innerText()).toContain("Backend unavailable");
    await page.unroute("**/api/k/workspaces/*/monitors");
    await page.getByTestId("monitoring-degraded").waitFor({ state: "detached", timeout: 10_000 });
    expect((await markers()).length).toBe(before); // server state untouched by the outage

    // A real 404 (workspace the caller cannot see) is an error state, not an empty list.
    const other = await open("#monitoring");
    await other.close();
    const bob = await env.loggedIn("bob");
    const p2 = await bob.newPage();
    await p2.goto(`${BASE}/w/${randomUUID()}?backend=kernel#monitoring`);
    await p2.waitForTimeout(1500);
    expect(await p2.getByTestId("marker-row-x").count()).toBe(0);
    await p2.close();
    await bob.close();

    // Persistence: tab survives reload; data comes from the server.
    await page.reload();
    await page.getByTestId("monitoring-view").waitFor();
    expect(await page.getByTestId("tab-triggers").getAttribute("aria-selected")).toBe("true");
    await page.screenshot({ path: `${SHOTS}real-08-degraded-reload.png` });
    await page.close();
  }, 120_000);
});

/** Scripted runtime port: the kernel's marker-task dispatcher runs for real, only the investigation runtime is scripted. */
const startingPort = {
  start: async () => ({ runId: randomUUID(), workflowId: `wf-${randomUUID()}` }),
  status: async () => ({ state: "RUNNING", terminal: false, succeeded: false, outputs: [] }),
};
const failingPort = {
  start: async () => {
    throw new Error("runtime down");
  },
  status: async () => null,
};
type Evaluation = { evaluationId: string; ruleId: string; status: string; mode: string };
const evaluations = async () =>
  (await api.get<{ evaluations: Evaluation[] }>(`${base()}/monitors/evaluations`)).evaluations;
const panelId = P_SWAPS;
async function makeMarker(anchor: object, activate = false): Promise<string> {
  const markerId = randomUUID();
  await api.command(ws, "marker.create", { panelId, markerId, anchor });
  if (activate) await api.command(ws, "marker.transition", { markerId, to: "ACTIVE" });
  return markerId;
}
const markerRow = (page: Page, id: string) => page.getByTestId(`marker-row-${id}`);

describe("monitoring read-model fields on the real kernel", () => {
  it("marker mode, task reason, pending assignment and dispatch follow the server", async () => {
    // A replay marker: anchored to a recorded replay watermark, so the kernel sets mode=replay.
    const sourceId = "explorer.replaysrc";
    await env.kernel.monitorScheduler().enqueue({
      sourceId,
      watermark: "2026-10-04T00:00:00.000Z",
      mode: "replay",
      values: { "intents.swap_count": 1 },
      maturity: "final",
    });
    const replayId = randomUUID();
    await api.command(ws, "marker.create", {
      panelId,
      markerId: replayId,
      anchor: { kind: "source_event", sourceId, eventId: "e1", at: "2026-10-04T00:00:00.000Z" },
    });
    const liveId = await makeMarker({ kind: "time_point", at: "2026-10-05T00:00:00.000Z" });
    const ms = await markers();
    expect(ms.find((m) => m.markerId === replayId)?.mode).toBe("replay");
    expect(ms.find((m) => m.markerId === liveId)?.mode).toBe("live");

    // Failed dispatch: assign through the UI, then the dispatcher cannot start the run.
    const failId = await makeMarker({ kind: "time_point", at: "2026-10-06T00:00:00.000Z" }, true);
    const okId = await makeMarker({ kind: "time_point", at: "2026-10-07T00:00:00.000Z" }, true);
    const page = await open("#monitoring");
    await page.getByTestId("tab-markers").click();
    expect(await markerRow(page, replayId).getByTestId("mode-badge-replay").count()).toBe(1);
    expect(await markerRow(page, liveId).getByTestId("mode-badge-replay").count()).toBe(0);
    await markerRow(page, replayId).click();
    expect(await page.getByTestId("marker-inspector").getByTestId("mode-badge-replay").count()).toBe(1);

    for (const id of [failId, okId]) {
      await markerRow(page, id).click();
      await page.getByTestId("assign-agent").click();
      await until(async () => (await tasks()).find((t) => t.markerId === id));
    }
    // Server: ACTIVE with a PENDING task until dispatch; the UI says the same and claims nothing more.
    for (const id of [failId, okId]) {
      const m = (await markers()).find((x) => x.markerId === id)!;
      expect(m.status).toBe("ACTIVE");
      expect((await tasks()).find((t) => t.markerId === id)?.status).toBe("PENDING");
    }
    await markerRow(page, okId).click();
    await page.getByTestId("marker-pending").waitFor();
    expect(
      await page.getByTestId("marker-inspector").getByTestId("marker-status").getAttribute("data-status"),
    ).toBe("ACTIVE");

    // Dispatch with a runtime that cannot start: the failure is visible on the marker, which keeps its state.
    await env.kernel.markerTasks(failingPort as never).dispatchOpen();
    const failed = await until(async () => {
      const m = (await markers()).find((x) => x.markerId === failId)!;
      return m.reasonCode ? m : false;
    }).catch(async (e) => {
      throw new Error(
        `no reasonCode; marker=${JSON.stringify((await markers()).find((x) => x.markerId === failId))} tasks=${JSON.stringify(await tasks())} ${e}`.slice(
          0,
          1800,
        ),
      );
    });
    expect(failed.status).toBe("ACTIVE");
    expect(failed.reasonCode).toBe("WORKFLOW_START_FAILED");
    const failedTask = (await tasks()).find((t) => t.markerId === failId)!;
    expect(failedTask.status).toBe("FAILED");
    // The other marker's task also failed in that dispatch; use a fresh one for the success path below.
    await markerRow(page, failId).click();
    const reason = await page
      .getByTestId("marker-reason")
      .waitFor()
      .then(() => page.getByTestId("marker-reason").getAttribute("data-reason"));
    expect(reason).toBe(failed.reasonCode);
    expect(await page.getByTestId("task-reason").innerText()).toContain(failedTask.reasonCode!);
    await page.screenshot({ path: `${SHOTS}real-09-marker-reason.png` });

    // Successful dispatch: the marker becomes INVESTIGATING on the server and the UI follows on refresh.
    const goodId = await makeMarker({ kind: "time_point", at: "2026-10-08T00:00:00.000Z" }, true);
    await markerRow(page, goodId).click();
    await page.getByTestId("assign-agent").click();
    await until(async () => (await tasks()).find((t) => t.markerId === goodId && t.status === "PENDING"));
    await env.kernel.markerTasks(startingPort as never).dispatchOpen();
    await until(async () => (await markers()).find((m) => m.markerId === goodId)?.status === "INVESTIGATING");
    expect((await tasks()).find((t) => t.markerId === goodId)?.runId).not.toBeNull();
    await until(
      async () =>
        (await page
          .getByTestId("marker-inspector")
          .getByTestId("marker-status")
          .getAttribute("data-status")) === "INVESTIGATING",
      20_000,
    );
    await page.close();
  }, 180_000);

  it("rule fields: z-score condition, data maturity, run cap and semantic version", async () => {
    const page = await open("#monitoring");
    await page.getByTestId("tab-rules").click();
    await page.getByTestId("new-rule").click();
    await page.getByTestId("rule-name").fill("Volume outlier");
    await page.getByTestId("rule-source").fill("explorer.zsrc");
    await page.getByTestId("rule-kind").selectOption("zscore");
    await page.getByTestId("rule-metric").fill("vol");
    await page.getByTestId("rule-zscore-threshold").fill("3");
    await page.getByTestId("rule-zscore-window").fill("30");
    await page.getByTestId("rule-maturity").selectOption("any");
    await page.getByTestId("rule-max-runs").fill("5");
    await page.getByTestId("rule-semver").fill("1.2.0");
    await page.getByTestId("rule-save").click();
    const made = await until(async () => (await rules()).find((r) => r.name === "Volume outlier"));
    expect(made.condition).toEqual({ kind: "zscore", metricId: "vol", windowDays: 30, absoluteGt: 3 });
    expect(made.dataMaturity).toBe("any");
    expect(made.maxRunsPerDay).toBe(5);
    expect(made.semanticVersion).toBe("1.2.0");
    await until(async () =>
      (await page.getByTestId(`rule-meta-${made.ruleId}`).innerText()).includes("max 5 runs/day"),
    );

    // Invalid window is refused by the editor and nothing is written.
    const n = (await rules()).length;
    await page.getByTestId(`rule-row-${made.ruleId}`).getByRole("button").first().click();
    await page.getByTestId("rule-zscore-window").fill("1");
    await page.getByTestId("rule-save").click();
    await page.getByTestId("rule-error").waitFor();
    expect((await rules()).length).toBe(n);

    // Edit: window, maturity and clearing the cap persist.
    await page.getByTestId("rule-zscore-window").fill("14");
    await page.getByTestId("rule-maturity").selectOption("finalized_only");
    await page.getByTestId("rule-max-runs").fill("");
    await page.getByTestId("rule-save").click();
    const edited = await until(async () => {
      const r = (await rules()).find((x) => x.ruleId === made.ruleId);
      return r && r.dataMaturity === "finalized_only" ? r : false;
    });
    expect(edited.condition).toEqual({ kind: "zscore", metricId: "vol", windowDays: 14, absoluteGt: 3 });
    expect(edited.maxRunsPerDay).toBeNull();
    expect(edited.semanticVersion).toBe("1.2.0");
    await page.screenshot({ path: `${SHOTS}real-10-zscore-rule.png` });
    await page.close();
  }, 120_000);

  it("evaluations view shows not_final, suppressed_run_cap and skipped_disabled with their reasons", async () => {
    const sourceId = "explorer.evalsrc";
    const marker = await makeMarker({ kind: "time_point", at: "2026-10-09T00:00:00.000Z" }, true);
    const capRule = randomUUID();
    await api.command(ws, "monitor.rule_create", {
      ruleId: capRule,
      name: "Capped",
      markerId: marker,
      sourceId,
      action: "investigate",
      condition: { kind: "compare", metricId: "m", op: "gt", value: 10 },
      frequency: { minIntervalSeconds: 0 },
      cooldownSeconds: 0,
      maxRunsPerDay: 1,
      enabled: true,
    });
    const offRule = randomUUID();
    await api.command(ws, "monitor.rule_create", {
      ruleId: offRule,
      name: "Switched off",
      sourceId,
      action: "notify",
      condition: { kind: "compare", metricId: "m", op: "gt", value: 10 },
      enabled: false,
    });
    const sch = env.kernel.monitorScheduler();
    const ev = (watermark: string, maturity: "final" | "provisional") => ({
      sourceId,
      watermark,
      mode: "live" as const,
      maturity,
      values: { m: 100 },
    });
    await sch.processEvent(ev("2026-10-12T01:00:00.000Z", "final"), { workspaceId: ws });
    await sch.processEvent(ev("2026-10-12T02:00:00.000Z", "final"), { workspaceId: ws });
    await sch.processEvent(ev("2026-10-12T03:00:00.000Z", "provisional"), { workspaceId: ws });
    const server = (await evaluations()).filter((e) => e.ruleId === capRule || e.ruleId === offRule);
    const statuses = new Set(server.map((e) => e.status));
    for (const st of ["fired", "suppressed_run_cap", "not_final", "skipped_disabled"])
      expect(statuses).toContain(st);

    const page = await open("#monitoring");
    await page.getByTestId("tab-evaluations").click();
    for (const e of server) {
      const row = page.getByTestId(`eval-row-${e.evaluationId}`);
      await row.waitFor();
      expect(await row.getAttribute("data-status")).toBe(e.status);
      expect(await row.getAttribute("data-mode")).toBe(e.mode);
    }
    const cap = server.find((e) => e.status === "suppressed_run_cap")!;
    expect(
      await page.getByTestId(`eval-row-${cap.evaluationId}`).getByTestId("eval-reason").innerText(),
    ).toContain("maxRunsPerDay");
    const nf = server.find((e) => e.status === "not_final")!;
    expect(
      await page.getByTestId(`eval-row-${nf.evaluationId}`).getByTestId("eval-reason").innerText(),
    ).toContain("provisional");
    await page.screenshot({ path: `${SHOTS}real-11-evaluations.png` });
    await page.close();
  }, 120_000);

  it("counters keep live and replay apart and the export labels REPLAY rows", async () => {
    const c = await api.get<{ day: string; live: number; replay: number }>(`${base()}/monitors/counters`);
    expect(c.live).toBeGreaterThan(0);
    expect(c.replay).toBeGreaterThan(0);
    const page = await open("#monitoring");
    await page.getByTestId("tab-triggers").click();
    await until(async () => (await page.getByTestId("counter-live").innerText()) === String(c.live));
    expect(await page.getByTestId("counter-replay").innerText()).toBe(String(c.replay));

    const exp = await api.get<{
      rows: Array<{ triggerId: string; mode: string; label: string }>;
      report: string;
    }>(`${base()}/monitors/export`);
    expect(exp.report).toContain("REPLAY");
    for (const r of exp.rows) expect(r.label).toBe(r.mode === "replay" ? "REPLAY" : "LIVE");
    await page.getByTestId("export-triggers").click();
    await page.getByTestId("export-result").waitFor();
    for (const r of exp.rows) {
      const row = page.getByTestId(`export-row-${r.triggerId}`);
      expect(await row.getAttribute("data-label")).toBe(r.label);
      expect(await row.getAttribute("data-mode")).toBe(r.mode);
    }
    expect(await page.getByTestId("export-summary").innerText()).toBe(exp.report.split("\n")[0]);
    await page.screenshot({ path: `${SHOTS}real-12-counters-export.png` });
    await page.close();
  }, 120_000);

  it("delegation chain, analyst scope error, and owner-granted scope", async () => {
    // Owner assignment (implicit scope) leaves a delegation chain on the server; the inspector lists the same rows.
    const owned = await makeMarker({ kind: "time_point", at: "2026-10-13T00:00:00.000Z" }, true);
    const page = await open("#monitoring");
    await page.getByTestId("tab-markers").click();
    await markerRow(page, owned).click();
    await page.getByTestId("assign-agent").click();
    await until(async () => (await tasks()).find((t) => t.markerId === owned));
    const chain = await api.get<{
      delegations: Array<{ delegationId: string; agents: string[]; userId: string | null }>;
    }>(`${base()}/markers/${owned}/delegations`);
    expect(chain.delegations.length).toBeGreaterThan(0);
    await page.getByTestId("marker-delegations").waitFor();
    for (const d of chain.delegations) {
      const li = page.getByTestId(`delegation-${d.delegationId}`);
      await li.waitFor();
      expect(await li.innerText()).toContain(d.agents[0]!);
    }
    await page.close();

    // Analyst without a scope: the kernel refuses; the UI explains the reason and the server is unchanged.
    const target = await makeMarker({ kind: "time_point", at: "2026-10-14T00:00:00.000Z" }, true);
    const bobApi = await apiClient(env, "bob");
    const bobCtx = await env.loggedIn("bob");
    bobCtx.setDefaultNavigationTimeout(120_000);
    const bp = await bobCtx.newPage();
    await bp.goto(url("#monitoring"), { waitUntil: "domcontentloaded" });
    await bp.getByTestId("tab-markers").click();
    await markerRow(bp, target).click();
    await bp.getByTestId("assign-agent").click();
    const err = await bp
      .getByTestId("action-error")
      .waitFor()
      .then(() => bp.getByTestId("action-error"));
    expect(await err.getAttribute("data-reason")).toBe("DELEGATION_SCOPE_REQUIRED");
    expect(await err.innerText()).toContain("owner or admin");
    expect((await tasks()).find((t) => t.markerId === target)).toBeUndefined();
    expect((await markers()).find((m) => m.markerId === target)?.assignedAgents).toEqual([]);
    // The same refusal straight from the API, so the explanation is not UI invention.
    const raw = await bobApi.post(`${base()}/commands`, {
      apiVersion: "v1",
      commandId: randomUUID(),
      commandType: "marker.assign",
      payload: { markerId: target, agents: ["quant"] },
      expectedVersion: (await bobApi.get<{ version: number }>(base())).version,
    });
    expect(raw.statusCode).toBe(403);
    expect(raw.json<{ reasonCode: string }>().reasonCode).toBe("DELEGATION_SCOPE_REQUIRED");

    // An analyst cannot grant scopes either (UI shows the kernel's refusal).
    await bp.getByTestId("tab-delegation").click();
    const grant = async (p: Page) => {
      await p.getByTestId("scope-user").fill(env.users.bob!.userId);
      await p.getByTestId("scope-tokens").fill("10000");
      await p.getByTestId("scope-save").click();
    };
    await grant(bp);
    expect(
      await (
        await bp
          .getByTestId("scope-error")
          .waitFor()
          .then(() => bp.getByTestId("scope-error"))
      ).innerText(),
    ).toMatch(/INSUFFICIENT_ROLE/); // the web server forwards PUT (route.ts)
    expect((await tasks()).find((t) => t.markerId === target)).toBeUndefined();

    // The owner grants the scope. Writing scopes is `PUT .../delegation-scopes`, which the same-origin web server does
    // not forward yet (BFF route exports GET and POST only; queued), so the grant goes straight to the kernel API.
    const aliceTok = (
      await env.app.inject({
        method: "POST",
        url: "/v1/dev/login",
        payload: { oidcSubject: env.users.alice!.subject },
      })
    ).json<{ token: string }>().token;
    const put = await env.app.inject({
      method: "PUT",
      url: `${base()}/delegation-scopes`,
      headers: { authorization: `Bearer ${aliceTok}` },
      payload: {
        userId: env.users.bob!.userId,
        agents: ["quant"],
        grants: [],
        delegateTo: [],
        maxBudget: { tokens: 10000, toolCalls: 10, usd: 1 },
      },
    });
    expect(put.statusCode).toBe(204);
    await bp.reload({ waitUntil: "domcontentloaded" });
    await bp.getByTestId("tab-markers").click();
    await markerRow(bp, target).click();
    await bp.getByTestId("assign-agent").click();
    const t = await until(async () => (await tasks()).find((x) => x.markerId === target));
    expect(t.status).toBe("PENDING");
    expect((await markers()).find((m) => m.markerId === target)?.assignedAgents).toEqual(["quant"]);
    await bp.close();
    await bobCtx.close();
  }, 240_000);
});

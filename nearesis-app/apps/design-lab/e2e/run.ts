import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, chromium } from "playwright";
import { ORIGIN, ensureServer } from "./server";

const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../NEARESIS_Build_Bible/reports/TESTS/UI-DESIGN",
);
const SHOTS = resolve(OUT, "screenshots");
const ROUTES = [
  "workspace",
  "workspace-empty",
  "workspace-states",
  "workspace-approval",
  "workspace-complete",
  "workspace-blocked",
  "components",
  "charts",
] as const;
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "400", width: 400, height: 860 },
] as const;
const THEMES = ["light", "dark"] as const;

const failures: string[] = [];
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failures.push(msg);
};

async function open(page: Page, route: string, theme: string, extra = "") {
  await page.goto(`${ORIGIN}/?theme=${theme}${extra}#/${route}`);
  await page.reload();
  await page.waitForSelector("#root > *");
  await page.waitForTimeout(route.startsWith("workspace") || route === "charts" ? 1800 : 400);
  await page.evaluate(() => document.fonts.ready);
}

async function main() {
  const stop = await ensureServer();
  mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  const axeSummary: Array<{
    route: string;
    theme: string;
    viewport: string;
    serious: number;
    critical: number;
    moderate: number;
    minor: number;
    ids: string[];
  }> = [];
  const shots: string[] = [];

  // 1. Screenshots + axe for every screen, theme and viewport.
  for (const vp of VIEWPORTS)
    for (const theme of THEMES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: theme,
      });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      for (const route of ROUTES) {
        await open(page, route, theme);
        const file = `${route}.${theme}.${vp.name}.png`;
        await page.screenshot({ path: resolve(SHOTS, file) });
        shots.push(`screenshots/${file}`);
        const r = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"])
          .analyze();
        const n = (i: string) => r.violations.filter((v) => v.impact === i).length;
        axeSummary.push({
          route,
          theme,
          viewport: vp.name,
          serious: n("serious"),
          critical: n("critical"),
          moderate: n("moderate"),
          minor: n("minor"),
          ids: r.violations.map((v) => `${v.impact}:${v.id}(${v.nodes.length})`),
        });
      }
      check(
        errors.length === 0,
        `no console or page errors (${theme} ${vp.name})${errors.length ? `: ${errors[0]}` : ""}`,
      );
      await ctx.close();
    }

  // 2. Tall canvas shots (whole canvas, 1440 wide) so every panel kind is visible.
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 2600 }, colorScheme: theme });
    const page = await ctx.newPage();
    for (const route of ["workspace", "workspace-states"]) {
      await open(page, route, theme, "&chat=closed");
      await page.waitForTimeout(1500);
      const file = `${route}.${theme}.1440-full.png`;
      await page.screenshot({ path: resolve(SHOTS, file) });
      shots.push(`screenshots/${file}`);
    }
    await ctx.close();
  }

  // 3. Interactions at 1440 light: collapsed sidebar, command palette, hover toolbar, live run stream with approval.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const page = await ctx.newPage();
    await open(page, "workspace", "light", "&sidebar=collapsed");
    await page.screenshot({ path: resolve(SHOTS, "sidebar-collapsed.light.1440.png") });
    shots.push("screenshots/sidebar-collapsed.light.1440.png");

    await open(page, "workspace", "light");
    await page.keyboard.press("Control+k");
    await page.waitForSelector("[cmdk-root]");
    await page.keyboard.type("solana");
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(SHOTS, "command-palette.light.1440.png") });
    shots.push("screenshots/command-palette.light.1440.png");
    check((await page.locator("[cmdk-item]").count()) >= 1, "command palette filters to matching items");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[cmdk-root]", { state: "detached" });
    check(true, "Escape closes the command palette");

    await page.locator('[data-testid="panel-p1"]').hover();
    await page.waitForTimeout(350);
    await page.screenshot({ path: resolve(SHOTS, "panel-hover-toolbar.light.1440.png") });
    shots.push("screenshots/panel-hover-toolbar.light.1440.png");

    // Live mock stream: submit, wait for the approval, approve, wait for the terminal state.
    await open(page, "workspace", "light", "&speed=12");
    await page
      .getByTestId("ask-input")
      .fill("Did solver fill rates drop on Solana after the 24 October outage?");
    await page.getByTestId("ask-submit").click();
    await page.waitForSelector('[data-testid="approval-card"][data-approval-status="pending"]', {
      timeout: 20000,
    });
    const hash = await page.getByTestId("approval-hash").first().innerText();
    check(/^sha256:[0-9a-f]{64}$/.test(hash), "approval card shows the full action hash it will submit");
    check(await page.getByTestId("ask-submit").isDisabled(), "composer is disabled while a run is active");
    await page.screenshot({ path: resolve(SHOTS, "chat-live-approval.light.1440.png") });
    shots.push("screenshots/chat-live-approval.light.1440.png");
    await page.getByTestId("approval-approve").click();
    await page.waitForSelector('[data-testid="run-status"][data-run-state="PARTIAL"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="proposed-panels"]');
    check((await page.getByTestId("abstention-card").count()) === 1, "abstention is shown as its own card");
    await page.getByRole("button", { name: "Add to canvas" }).first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(SHOTS, "chat-live-complete.light.1440.png") });
    shots.push("screenshots/chat-live-complete.light.1440.png");
    check(
      await page.getByTestId("ask-submit").isDisabled(),
      "composer re-enables only with text after the run ends",
    );
    await ctx.close();
  }

  // 4. Keyboard: focus ring is visible on interactive controls.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await open(page, "workspace", "light");
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, outline: cs.outlineStyle, width: cs.outlineWidth };
    });
    check(
      !!ring && ring.outline !== "none" && parseFloat(ring.width) >= 2,
      `first Tab stop shows a focus ring (${JSON.stringify(ring)})`,
    );
    await ctx.close();
  }

  // 5. Reduced motion: tokens collapse, loops stop, charts do not animate.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await open(page, "workspace-states", "light");
    const info = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const running = document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => ({
          d: Number(a.effect?.getTiming().duration ?? 0),
          n: (a as CSSAnimation).animationName ?? "",
        }))
        .filter((a) => a.d > 1);
      return { dur: root.getPropertyValue("--dur-base").trim(), running };
    });
    check(
      parseFloat(info.dur) <= 0.01 && info.dur.endsWith("ms"),
      `--dur-base collapses under prefers-reduced-motion (${info.dur})`,
    );
    check(
      info.running.length === 0,
      `no CSS animation is running under reduced motion (${JSON.stringify(info.running)})`,
    );
    await page.screenshot({ path: resolve(SHOTS, "reduced-motion.light.1440.png") });
    shots.push("screenshots/reduced-motion.light.1440.png");
    await ctx.close();
    // Same through the explicit switch the lab uses for demos.
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const p2 = await ctx2.newPage();
    await open(p2, "workspace-states", "light", "&motion=reduced");
    const run2 = await p2.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => a.playState === "running" && Number(a.effect?.getTiming().duration ?? 0) > 1).length,
    );
    check(run2 === 0, "data-motion=reduced also stops all running animations");
    await ctx2.close();
  }

  // 6. Chart DOM bound inside the real workspace (<= 5000 nodes per chart panel, C18 DOM threshold).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await open(page, "workspace", "light");
    const counts = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="panel-p"]')].map((p) => p.querySelectorAll("*").length),
    );
    check(
      counts.every((c) => c <= 5000),
      `every panel stays under 5000 DOM nodes (max ${Math.max(...counts)})`,
    );
    await ctx.close();
  }

  await browser.close();
  stop();

  const bad = axeSummary.filter((a) => a.serious + a.critical > 0);
  check(
    bad.length === 0,
    `axe: 0 serious or critical issues across ${axeSummary.length} page states${bad.length ? ` (${bad.map((b) => `${b.route}/${b.theme}/${b.viewport}: ${b.ids.join(",")}`).join("; ")})` : ""}`,
  );
  writeFileSync(
    resolve(OUT, "axe-summary.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        tags: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
        pageStates: axeSummary.length,
        seriousOrCritical: bad.length,
        results: axeSummary,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    resolve(OUT, "screenshots.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), files: shots }, null, 2) + "\n",
  );
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

void main();

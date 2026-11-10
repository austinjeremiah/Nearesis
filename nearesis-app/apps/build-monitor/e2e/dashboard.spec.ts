import { writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  agentRecord,
  tempPaths,
  testResult,
  writeEvidence,
  writeIndex,
  writeJson,
} from "../test/fixtures.ts";

const pkgRoot = resolve(import.meta.dirname, "..");
const shotDir = resolve(pkgRoot, "..", "..", "..", "NEARESIS_Build_Bible", "reports", "TESTS", "MONITOR");
const PORT = 4491;

let child: ChildProcess;
const paths = tempPaths();
const file = join(paths.coordDir, "agents/A9.json");

test.beforeAll(async () => {
  writeJson(file, agentRecord());
  const t0 = Date.now();
  const evs = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({
      ts: new Date(t0 - i * 1000).toISOString(),
      session: "S",
      engine: "ENGINE_A",
      kind: "commit.created",
      subject: `c${i}`,
    }),
  );
  writeFileSync(join(paths.coordDir, "EVENTS.jsonl"), evs.join("\n") + "\n");
  writeFileSync(
    join(paths.coordDir, "INTEGRATION_QUEUE.md"),
    "# Queue\n- [OPEN] 2026-11-10T11:58Z ENGINE_B contract-change \u2014 Needs a field. " +
      "Long explanation. ".repeat(60) +
      " \u2014 packages/x\n",
  );
  writeIndex(paths, [
    { testId: "BOOT01", gate: "G00", status: "IMPLEMENTED" },
    { testId: "BOOT02", gate: "G00" },
    { testId: "BOOT03", gate: "G00" },
    { testId: "K01", gate: "G01" },
  ]);
  writeEvidence(paths, testResult("BOOT01", "FAIL", new Date(Date.now() - 60_000).toISOString(), "r1"));
  child = spawn(resolve(pkgRoot, "..", "..", "node_modules/.bin/tsx"), ["server/main.ts"], {
    cwd: pkgRoot,
    env: {
      ...process.env,
      MONITOR_PORT: String(PORT),
      NEARESIS_BIBLE_DIR: paths.bibleDir,
      NEARESIS_COORD_DIR: paths.coordDir,
      NEARESIS_REPORTS_DIR: paths.reportsDir,
      NEARESIS_TEST_INDEX: paths.testIndex,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolveP, reject) => {
    const t = setTimeout(() => reject(new Error("monitor did not start")), 30_000);
    child.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("listening")) {
        clearTimeout(t);
        resolveP();
      }
    });
    child.on("exit", (c) => reject(new Error(`monitor exited ${c}`)));
  });
});
test.afterAll(() => {
  child.kill("SIGTERM");
});

test("agent record change appears on screen without reload", async ({ page }) => {
  await page.goto(`http://127.0.0.1:${PORT}/#/agents`);
  const status = page.getByTestId("status-A9");
  await expect(status).toHaveText("RUNNING", { timeout: 10_000 });
  await expect(page.getByTestId("engine-B")).toBeVisible();

  let reloaded = false;
  page.on("load", () => (reloaded = true));

  writeJson(file, agentRecord({ status: "BLOCKED", blockerIds: ["BLK-TEST"] }));
  await expect(status).toHaveText("BLOCKED", { timeout: 5_000 });
  await expect(page.getByTestId("agent-A9")).toContainText("BLK-TEST");

  writeJson(file, agentRecord({ heartbeatAt: new Date(Date.now() - 11 * 60_000).toISOString() }));
  await expect(status).toHaveText("STALE", { timeout: 5_000 });
  await expect(page.getByTestId("agent-A9")).toContainText("record says RUNNING");
  expect(reloaded).toBe(false);

  await page.screenshot({ path: join(shotDir, "dashboard-agent-change.png"), fullPage: true });
});

const waitReady = async (page: import("@playwright/test").Page): Promise<void> => {
  await page.goto(`http://127.0.0.1:${PORT}/#/overview`);
  await expect(page.getByTestId("lede")).toBeVisible({ timeout: 10_000 });
};

test("phase chart renders 6 gate rows plus 7 greyed rows and updates live on evidence change", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await waitReady(page);
  await expect(page.locator('[data-testid^="phase-row-"]')).toHaveCount(6);
  await expect(page.locator('[data-testid^="phase-outside-"]')).toHaveCount(7);
  const g0 = page.getByTestId("inner-G00");
  await expect(g0).toHaveAttribute("data-passed", "0");
  await expect(page.getByTestId("kpi-passed")).toContainText("0 / 4");
  await expect(page.getByTestId("phase-row-G01")).toContainText("waits on G00");

  let reloaded = false;
  page.on("load", () => (reloaded = true));
  writeEvidence(paths, testResult("BOOT01", "PASS", new Date().toISOString(), "r2"));
  await expect(g0).toHaveAttribute("data-passed", "1", { timeout: 5_000 });
  await expect(page.getByTestId("kpi-passed")).toContainText("1 / 4");
  expect(reloaded).toBe(false);

  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: join(shotDir, "redesign-light-1440.png"), fullPage: true });
});

test("dark theme renders", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark" });
  await waitReady(page);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(19, 20, 22)");
  await page.screenshot({ path: join(shotDir, "redesign-dark-1440.png"), fullPage: true });
});

test("no horizontal document scroll at 400 px on every tab", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await waitReady(page);
  for (const tab of ["overview", "agents", "tests", "tasks", "reports"]) {
    await page.goto(`http://127.0.0.1:${PORT}/#/${tab}`);
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `tab ${tab}`).toBeLessThanOrEqual(0);
  }
  await page.goto(`http://127.0.0.1:${PORT}/#/overview`);
  await page.screenshot({ path: join(shotDir, "redesign-400.png"), fullPage: true });
});

test("test drawer opens from the matrix and closes with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${PORT}/#/tests`);
  await page.getByTestId("test-BOOT01").click();
  await expect(page.getByRole("dialog")).toContainText("Run history");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("waiting items are clamped and open the queue file at the entry; activity is capped at 12 per group", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await waitReady(page);
  const title = page.getByTestId("wait-title").first();
  await expect(title).toHaveText("Needs a field.");
  const h = await title.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeLessThan(50);
  await expect(page.locator(".evrow")).toHaveCount(12);
  await page
    .getByRole("button", { name: /show more/ })
    .first()
    .click();
  await expect(page.locator(".evrow")).toHaveCount(30);
  await page.getByTestId("wait-title").first().click();
  await expect(page.getByRole("dialog").locator('[data-hl="1"]')).toContainText("[OPEN]");
});

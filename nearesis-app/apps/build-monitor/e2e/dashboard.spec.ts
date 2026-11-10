import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { agentRecord, tempPaths, writeJson } from "../test/fixtures.ts";

const pkgRoot = resolve(import.meta.dirname, "..");
const shotDir = resolve(pkgRoot, "..", "..", "..", "NEARESIS_Build_Bible", "reports", "TESTS", "MONITOR");
const PORT = 4491;

let child: ChildProcess;
const paths = tempPaths();
const file = join(paths.coordDir, "agents/A9.json");

test.beforeAll(async () => {
  writeJson(file, agentRecord());
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
  await page.goto(`http://127.0.0.1:${PORT}/`);
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

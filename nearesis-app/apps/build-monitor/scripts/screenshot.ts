/** Capture the RUNNING real-repo dashboard (default http://127.0.0.1:4400) to reports/TESTS/MONITOR/real-*.png. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { defaultPaths } from "../server/paths.ts";

const base = process.env.MONITOR_URL ?? "http://127.0.0.1:4400";
const out = join(defaultPaths().bibleDir, "reports", "TESTS", "MONITOR");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const shots: [string, number, "light" | "dark"][] = [
  ["real-light-1440.png", 1440, "light"],
  ["real-dark-1440.png", 1440, "dark"],
  ["real-400.png", 400, "light"],
];
for (const [name, width, scheme] of shots) {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${base}/#/overview`);
  await page.getByTestId("lede").waitFor({ timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, name), fullPage: true });
  console.log(`saved ${join(out, name)}`);
  await ctx.close();
}
await browser.close();

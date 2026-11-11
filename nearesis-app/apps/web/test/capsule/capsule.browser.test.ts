/**
 * Research capsule viewer browser tests (real web app + kernel session; Playwright Chromium). The capsule record is a
 * TEST-ONLY SYNTHETIC fixture injected via file; the page must never show an unverified artifact as verified.
 * Not a defined acceptance ID: results are reported as browser-test results only.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Env, loggedIn, open, startEnv, WEB_DIR } from "../thesis/harness.ts";
import { syntheticCapsule } from "../thesis/synthetic.ts";

const OUT = `${WEB_DIR}test-results/capsule`;
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;

let env: Env;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
}, 600_000);
afterAll(async () => {
  await env?.close();
});

describe("research capsule viewer", () => {
  it("reports unavailable when no capsule record exists", async () => {
    rmSync(env.files.capsule, { force: true });
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/capsule`, "__capsule");
    await expect(page.getByTestId("capsule-unavailable").textContent()).resolves.toMatch(
      /Nothing here is shown as verified/,
    );
    expect(await page.getByTestId("proof-outlayer").count()).toBe(0);
    await ctx.close();
  }, 300_000);

  it("never upgrades a malformed 'verified' record, separates local reproducibility from OutLayer proof, and demotes unsupported claims", async () => {
    writeFileSync(env.files.capsule, JSON.stringify(syntheticCapsule()));
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(
      ctx,
      `/w/${env.workspaceId}/capsule?id=cap-synthetic-1`,
      "__capsule",
    );
    await page.getByTestId("proof-outlayer").waitFor();
    await expect(page.getByTestId("proof-outlayer").getAttribute("data-status")).resolves.toBe("unverified");
    await expect(page.getByTestId("proof-outlayer").textContent()).resolves.toMatch(
      /Unverified.*lacks a job id or check time/,
    );
    await expect(page.getByTestId("proof-local").getAttribute("data-status")).resolves.toBe("reproduced");
    await expect(page.getByTestId("capsule-status-summary").textContent()).resolves.toContain(
      "Not cryptographically verified",
    );
    await expect(page.getByTestId("capsule-synthetic").isVisible()).resolves.toBe(true);
    // C1 cites R1 (present) -> derived; C2 cites R9 (absent) -> unsupported; C3 is a hypothesis.
    await expect(page.getByTestId("capsule-claim-C1").getAttribute("data-class")).resolves.toBe("derived");
    await expect(page.getByTestId("capsule-claim-C2").getAttribute("data-class")).resolves.toBe(
      "unsupported",
    );
    await expect(page.getByTestId("capsule-claim-C3").getAttribute("data-class")).resolves.toBe("hypothesis");
    await expect(page.getByTestId("capsule-hashes").textContent()).resolves.toContain("not recorded"); // container digest null
    await expect(page.getByTestId("verification-failures").textContent()).resolves.toContain(
      "attestation_missing",
    );
    await expect(page.getByTestId("last-verified").textContent()).resolves.toContain("2026-11-11T01:00:00Z");
    // Provenance lineage from the claim walks to the source and reports the dangling reference.
    await page.getByTestId("prov-node-C1").click();
    const lineage = await page.getByTestId("lineage").textContent();
    expect(lineage).toContain("NEAR Intents Explorer");
    await expect(page.getByTestId("lineage-missing").textContent()).resolves.toContain("C1 → ghost");
    // The unsafe export link is not rendered as a link.
    expect(await page.locator("a[href^='javascript:']").count()).toBe(0);
    await expect(page.getByTestId("capsule-rebuild").textContent()).resolves.toContain(
      "pnpm research:rebuild --snapshot",
    );
    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/capsule-viewer.png`, fullPage: true });
    await ctx.close();
  }, 300_000);

  it("shows OutLayer-verified only when the record carries a job id and check time", async () => {
    writeFileSync(
      env.files.capsule,
      JSON.stringify(
        syntheticCapsule({ outlayer: { jobId: "job-fixture-1", checkedAt: "2026-11-11T02:00:00Z" } }),
      ),
    );
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/capsule?id=cap-synthetic-1`, "__capsule");
    await page.getByTestId("proof-outlayer").waitFor();
    await expect(page.getByTestId("proof-outlayer").getAttribute("data-status")).resolves.toBe("verified");
    // Still labelled SYNTHETIC: a fixture record is never presented as research evidence.
    await expect(page.getByTestId("capsule-synthetic").isVisible()).resolves.toBe(true);
    rmSync(env.files.capsule, { force: true });
    await ctx.close();
  }, 300_000);
});

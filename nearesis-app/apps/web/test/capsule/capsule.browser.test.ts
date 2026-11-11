/**
 * Research capsule viewer browser tests against the live capsule API (V1): a real capsule built with the capsule CLI
 * (SYNTHETIC fixture snapshot, labelled). The page must mirror the API record and never show an unverified artifact as
 * verified. Not a defined acceptance ID: results are reported as browser-test results only.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapsuleResponseRecord } from "@nearesis/contracts";
import { API_PORT, BASE, type Env, loggedIn, open, startEnv, WEB_DIR } from "../thesis/harness.ts";

const OUT = `${WEB_DIR}test-results/capsule`;
const contentCsp = (v: unknown[]) =>
  process.env.NEARESIS_THESIS_DEV === "1"
    ? v.filter((x) => !String((x as { source?: string }).source ?? "").includes("next-devtools"))
    : v;
const CLASS: Record<string, string> = {
  observed_fact: "observed",
  derived_statistic: "derived",
  agent_interpretation: "interpretation",
  hypothesis: "hypothesis",
  unsupported: "unsupported",
};

let env: Env;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
}, 600_000);
afterAll(async () => {
  await env?.close();
});

describe("research capsule viewer (live capsule API)", () => {
  it("reports unavailable when no capsule has been published", async () => {
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/capsule`, "__capsule");
    await expect(page.getByTestId("capsule-unavailable").textContent()).resolves.toMatch(
      /No research capsule has been published/,
    );
    expect(await page.getByTestId("proof-outlayer").count()).toBe(0);
    await ctx.close();
  }, 300_000);

  it("mirrors the API record: verification kept apart, claims classed, exports served intact through the BFF", async () => {
    const id = env.buildCapsule();
    const token = await env.kernel.devAuth!.login(env.subject);
    const rec = CapsuleResponseRecord.parse(
      await (
        await fetch(`http://127.0.0.1:${API_PORT}/v1/capsules/${id}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json(),
    );
    if (rec.status !== "available") throw new Error(`API reports ${rec.reason}`);
    const c = rec.capsule;
    const ctx = await loggedIn(env);
    const { page, csp, errors } = await open(ctx, `/w/${env.workspaceId}/capsule?id=${id}`, "__capsule");
    await page.getByTestId("proof-outlayer").waitFor();
    await expect(page.getByTestId("proof-local").getAttribute("data-status")).resolves.toBe(
      c.verification.local.status,
    );
    const outlayerShown = await page.getByTestId("proof-outlayer").getAttribute("data-status");
    const o = c.verification.outlayer;
    expect(outlayerShown).toBe(
      o.status === "verified" && o.jobId && o.checkedAt
        ? "verified"
        : o.status === "failed"
          ? "failed"
          : "unverified",
    );
    if (outlayerShown !== "verified")
      await expect(page.getByTestId("capsule-status-summary").textContent()).resolves.toContain(
        "Not cryptographically verified",
      );
    if (c.sourceLabel === "SYNTHETIC")
      await expect(page.getByTestId("capsule-synthetic").isVisible()).resolves.toBe(true);
    const results = new Set(c.results.map((r) => r.id));
    for (const cl of c.claims) {
      const supported = cl.resultIds.length > 0 && cl.resultIds.every((r) => results.has(r));
      const expected =
        CLASS[cl.claimClass] === "hypothesis" || supported ? CLASS[cl.claimClass] : "unsupported";
      await expect(page.getByTestId(`capsule-claim-${cl.id}`).getAttribute("data-class")).resolves.toBe(
        expected,
      );
    }
    const hashes = await page.getByTestId("capsule-hashes").textContent();
    expect(hashes).toContain(c.hashes.sourceSnapshotHash);
    expect(hashes).toContain(c.hashes.resultManifestHash);
    // Exports: every link goes through the same-origin BFF and returns the exact bytes the record hashes.
    const links = page.getByTestId("capsule-export-link");
    expect(await links.count()).toBe(c.exports.filter((e) => e.href.startsWith("/v1/capsules/")).length);
    const exportChecks: Array<{ href: string; status: number; shaOk: boolean; sandbox: boolean }> = [];
    for (const e of c.exports) {
      const r = await ctx.request.get(`${BASE}/api/k/${e.href.slice(4)}`);
      const body = await r.body();
      const sha = createHash("sha256").update(body).digest("hex");
      exportChecks.push({
        href: e.href,
        status: r.status(),
        shaOk: e.sha256 === null || sha === e.sha256,
        sandbox: (r.headers()["content-security-policy"] ?? "").includes("sandbox"),
      });
    }
    expect(exportChecks.every((x) => x.status === 200 && x.shaOk && x.sandbox)).toBe(true);
    expect(contentCsp(await csp())).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `${OUT}/capsule-viewer-live.png`, fullPage: true });
    await ctx.close();
  }, 600_000);

  it("refuses unknown capsules and traversal through the BFF", async () => {
    const ctx = await loggedIn(env);
    const { page } = await open(ctx, `/w/${env.workspaceId}/capsule?id=does-not-exist`, "__capsule");
    await expect(page.getByTestId("capsule-unavailable").textContent()).resolves.toMatch(/not found/);
    for (const p of [
      "capsules/cap-synthetic-2026-11-10/exports/../manifest.json",
      "capsules/cap-synthetic-2026-11-10/research/research_run.json",
    ])
      expect((await ctx.request.get(`${BASE}/api/k/${p}`)).status()).toBe(404);
    const anon = await env.browser.newContext();
    expect((await anon.request.get(`${BASE}/api/k/capsules`)).status()).toBeGreaterThanOrEqual(400);
    await anon.close();
    await ctx.close();
  }, 300_000);
});

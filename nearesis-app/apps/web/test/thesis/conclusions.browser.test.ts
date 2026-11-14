/**
 * R4 / amendment 002: the four comparison conclusions in the thesis and capsule UI. Each case builds a real capsule
 * (capsule CLI) whose research run is the a002 fixture with the primary comparison's inference record set to one
 * state. These run variants are TEST-ONLY and stay labelled SYNTHETIC. Reported as browser-test results.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Env, loggedIn, open, startEnv, WEB_DIR } from "./harness.ts";

const OUT = `${WEB_DIR}test-results/thesis`;
const APP = join(WEB_DIR, "..", "..");
const BASE_BUNDLE = join(APP, "packages/test-fixtures/research/signal-bundle-a002");
type Run = {
  estimates: {
    primary: { candidate: string; horizon: number; inference: Record<string, unknown> };
    byHorizonCandidate: Record<string, { inference: Record<string, unknown> }>;
    inferenceSummary?: Record<string, unknown>;
  };
};

/** A bundle whose primary comparison carries the given inference state (other comparisons unchanged). */
function variant(
  name: string,
  patch: { status: string; state: string; allowed: boolean; lower: boolean | null; reason?: string },
): string {
  const dir = join(mkdtempSync(join(tmpdir(), `bundle-${name}-`)), "bundle");
  cpSync(BASE_BUNDLE, dir, { recursive: true });
  const f = join(dir, "research_run.json");
  const run = JSON.parse(readFileSync(f, "utf8")) as Run;
  const key = `${run.estimates.primary.horizon}:${run.estimates.primary.candidate}`;
  for (const inf of [run.estimates.primary.inference, run.estimates.byHorizonCandidate[key]!.inference]) {
    inf.status = patch.status;
    inf.significance_claim_allowed = patch.allowed;
    inf.nested = false;
    if (patch.reason) inf.reason = patch.reason;
    else delete inf.reason;
    inf.conclusion = {
      ...(inf.conclusion as object),
      state: patch.state,
      observed_candidate_lower_error: patch.lower,
      statistically_meaningful_difference: patch.allowed,
    };
  }
  if (run.estimates.inferenceSummary)
    run.estimates.inferenceSummary.primaryStatisticalClaim = patch.allowed ? "supported" : "not_supported";
  writeFileSync(f, JSON.stringify(run));
  return dir;
}

const CASES = [
  {
    name: "valid",
    patch: { status: "VALID", state: "evidence_supports_difference", allowed: true, lower: true },
    expect: ["observed_lower_error", "meaningful_difference"],
    claim: "supported",
  },
  {
    name: "insufficient",
    patch: {
      status: "INSUFFICIENT_DATA",
      state: "insufficient_to_distinguish",
      allowed: false,
      lower: true,
      reason: "too few forecast origins for the fixed-smoothing test",
    },
    expect: ["observed_lower_error", "insufficient"],
    claim: "not supported",
  },
  {
    name: "not-validated",
    patch: {
      status: "METHOD_NOT_VALIDATED",
      state: "comparison_method_not_validated",
      allowed: false,
      lower: false,
      reason: "nested models: ordinary DM inference is not valid",
    },
    expect: ["not_validated"],
    claim: "not supported",
  },
  {
    name: "invalid-input",
    patch: {
      status: "INVALID_INPUT",
      state: "comparison_invalid_input",
      allowed: false,
      lower: null,
      reason: "degenerate loss differential",
    },
    expect: ["invalid_input"],
    claim: "not supported",
  },
] as const;

let env: Env;
beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  env = await startEnv();
}, 600_000);
afterAll(async () => {
  await env?.close();
});

describe("comparison conclusions (thesis and capsule)", () => {
  for (const c of CASES)
    it(`${c.name}: shows exactly the conclusions the inference record allows`, async () => {
      const id = env.buildCapsule(undefined, variant(c.name, c.patch), { skipResearchReproduction: true });
      const run = JSON.parse(
        readFileSync(join(env.files.capsuleDir, id, "research", "research_run.json"), "utf8"),
      ) as Run;
      const key = `${run.estimates.primary.horizon}:${run.estimates.primary.candidate}`;
      const ctx = await loggedIn(env);

      const th = await open(ctx, `/w/${env.workspaceId}/thesis`, "__thesis");
      await th.page
        .getByTestId("primary-conclusion")
        .waitFor({ timeout: 60_000 })
        .catch(async (e) => {
          const st = await th.page.evaluate(
            () =>
              (window as unknown as { __thesis?: { artifacts?: { status: string; reason?: string } } })
                .__thesis?.artifacts,
          );
          throw new Error(
            `primary conclusion missing: ${JSON.stringify(st)} errors=${JSON.stringify(th.errors)} ${e}`,
          );
        });
      const primaryKinds = await th.page
        .getByTestId("primary-conclusion")
        .locator("[data-testid='conclusion']")
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(primaryKinds).toEqual([...c.expect]);
      await expect(
        th.page
          .getByTestId(`conclusion-${key}`)
          .locator("[data-testid='conclusion']")
          .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind"))),
      ).resolves.toEqual([...c.expect]);
      await expect(th.page.getByTestId("primary-claim").textContent()).resolves.toBe(c.claim);
      await expect(th.page.getByTestId("inference-label").textContent()).resolves.toBe(
        "post_hoc_methodological_correction",
      );
      await expect(th.page.getByTestId("calibration-hash").textContent()).resolves.toMatch(
        /^sha256:[0-9a-f]{64}$/,
      );
      // No significance or causal wording anywhere in the comparison sections; "meaningful difference" only when VALID.
      const text = [
        await th.page.getByTestId("model-table").textContent(),
        await th.page.getByTestId("evidence-bull").textContent(),
        await th.page.getByTestId("inference-summary").textContent(),
      ].join(" ");
      expect(text).not.toMatch(/\bsignifican/i);
      expect(text).not.toMatch(/\bcaus(es|ed|al effect)\b/i);
      expect(text.includes("statistically meaningful difference")).toBe(c.name === "valid");
      if (c.name !== "valid" && c.patch.reason) expect(text).toContain(c.patch.reason);
      await th.page.getByTestId("model-table").scrollIntoViewIfNeeded();
      await th.page.screenshot({ path: `${OUT}/conclusions-${c.name}.png`, fullPage: true });

      const cap = await open(ctx, `/w/${env.workspaceId}/capsule?id=${id}`, "__capsule");
      await cap.page.getByTestId(`capsule-conclusion-${key}`).waitFor({ timeout: 60_000 });
      await expect(
        cap.page
          .getByTestId(`capsule-conclusion-${key}`)
          .locator("[data-testid='conclusion']")
          .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind"))),
      ).resolves.toEqual([...c.expect]);
      await expect(cap.page.getByTestId("primary-claim").textContent()).resolves.toBe(c.claim);
      const capText = (await cap.page.getByTestId("capsule-conclusions").textContent()) ?? "";
      expect(capText).not.toMatch(/\bsignifican/i);
      expect(capText.includes("statistically meaningful difference")).toBe(c.name === "valid");
      await ctx.close();
    }, 600_000);
});

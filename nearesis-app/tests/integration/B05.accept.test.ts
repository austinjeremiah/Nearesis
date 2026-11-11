import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { observe } from "@nearesis/acceptance";
import { STEP_NAMES, validateTrace } from "../../plugins/near-thesis/src/index.ts";
import { runFlow } from "./lib/flow.ts";
import { openStack, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => s?.close(), 120_000);

it("B05: the golden trace covers all 12 lifecycle steps, each run by its real component, with failures reported and an undeclared mock detected", async () => {
  if (await stopIfBlocked(s, "B05", "the real-stack flow")) return;
  // genuine run
  const good = await runFlow(s);
  const v = validateTrace(good.trace);
  expect(v.violations).toEqual([]);
  expect(good.trace.steps.map((x) => x.name)).toEqual([...STEP_NAMES]); // (a) 12 ordered
  for (const st of good.trace.steps) {
    expect(st.component.id && st.component.version).toBeTruthy();
    expect(st.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(st.startedAt <= st.endedAt).toBe(true);
    expect(st.evidence.length, `${st.name} ${st.status} ${st.reason_code} ${st.detail}`).toBeGreaterThan(0);
  }
  // (b) continuity: each step consumed the output hash of its latest completed dependency
  const by = new Map(good.trace.steps.map((x) => [x.name, x]));
  expect(by.get("discover")!.upstream).toBe(by.get("acquire")!.outputHash);
  expect(by.get("execute")!.upstream).toBe(by.get("plan")!.outputHash);
  expect(by.get("compose")!.upstream).toBe(by.get("execute")!.outputHash);
  expect(by.get("publish")!.upstream).toBe(by.get("audit")!.outputHash);
  // (c) mock steps are only inference providers; no data or semantic step is mock
  const mocks = good.trace.steps.filter((x) => x.mode === "mock");
  expect(mocks.length).toBeGreaterThan(0);
  for (const m of mocks) expect(m.component.id.startsWith("inference.")).toBe(true);
  for (const n of ["acquire", "discover", "monitor", "audit", "publish"] as const)
    expect(by.get(n)!.mode).not.toBe("mock");
  expect(by.get("commit")!.status).toBe("blocked");

  // (d) planted failing adapter: a recorded 401 from Explorer
  const bad = await runFlow(s, { explorer401: true });
  const vb = validateTrace(bad.trace);
  expect(vb.violations).toEqual([]);
  const bs = new Map(bad.trace.steps.map((x) => [x.name, x]));
  expect(bs.get("acquire")!.status).toBe("failed");
  expect(bs.get("acquire")!.reason_code).toBeTruthy();
  for (const n of [
    "discover",
    "plan",
    "execute",
    "compose",
    "investigate",
    "audit",
    "publish",
    "commit",
  ] as const) {
    expect(bs.get(n)!.status, n).toBe("blocked");
    expect(bs.get(n)!.reason_code).toBe("UPSTREAM_NOT_COMPLETED");
  }

  // (e) negative control: a mocked data step is detected and the verdict fails
  const neg = await runFlow(s, { mockStep: "acquire" });
  const vn = validateTrace(neg.trace);
  expect(vn.ok).toBe(false);
  expect(vn.violations.some((x) => x.rule === "mock_not_allowed" && x.step === "acquire")).toBe(true);
  // a tampered trace (broken chain, swallowed failure) is also rejected
  const broken = structuredClone(good.trace);
  broken.steps[5]!.upstream = "0".repeat(64);
  expect(validateTrace(broken).violations.some((x) => x.rule === "continuity")).toBe(true);
  const swallowed = structuredClone(bad.trace);
  swallowed.steps[2]!.reason_code = null;
  expect(validateTrace(swallowed).violations.some((x) => x.rule === "swallowed_failure")).toBe(true);

  observe({
    testId: "B05",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(good.trace.steps.map((x) => x.inputHash)))
      .digest("hex"),
    observed: `genuine run: 12 ordered steps (${good.trace.steps.map((x) => `${x.name}:${x.status}:${x.mode}`).join(" ")}), schema valid, hash chain continuous, mock only on inference components; Explorer-401 run: acquire failed (${bs.get("acquire")!.reason_code}) and 8 dependent steps blocked with UPSTREAM_NOT_COMPLETED; negative control (mocked acquire) detected: ${vn.violations.map((x) => x.rule).join(",")}; tampered and swallowed-failure traces rejected. Step 12 is recorded blocked (BLK-20261110-003: no testnet signing permitted).`,
    evidence: {
      trace: good.trace,
      failingRun: bad.trace.steps.map((x) => ({
        n: x.n,
        name: x.name,
        status: x.status,
        reason: x.reason_code,
        blockedBy: x.blockedBy,
      })),
      negativeControl: vn.violations,
      modeTable: good.trace.steps.map((x) => ({ step: x.name, component: x.component.id, mode: x.mode })),
    },
  });
}, 600_000);

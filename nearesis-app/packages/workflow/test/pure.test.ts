import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson as nodeCanon, sha256Hex as nodeSha } from "../../agent-runtime/src/canonical.ts";
import { actionHash, canonicalJson, childWorkflowId, dedupHash, sha256Hex } from "../src/pure.ts";

it("pure sha256 equals node:crypto for assorted inputs", () => {
  for (const s of [
    "",
    "a",
    "abc",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "é漢字🙂",
    randomBytes(300).toString("base64"),
  ])
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
});
it("canonical JSON sorts keys recursively and matches the agent-runtime implementation", () => {
  const v = { b: 1, a: { d: [3, { z: 1, y: undefined, x: null }], c: "s" } };
  expect(canonicalJson(v)).toBe('{"a":{"c":"s","d":[3,{"x":null,"z":1}]},"b":1}');
  expect(nodeCanon(v)).toBe(canonicalJson(v));
  expect(nodeSha("q")).toBe(sha256Hex("q"));
});
it("child workflow id is a deterministic function of the 5-tuple only", () => {
  const k = { workspaceId: "w", investigationId: "i", task: "t", modelVersion: "m", inputSnapshot: "s" };
  expect(childWorkflowId(k)).toBe(childWorkflowId({ ...k }));
  expect(childWorkflowId(k)).toBe(`child-${dedupHash(k)}`);
  for (const f of Object.keys(k))
    expect(childWorkflowId({ ...k, [f]: "other" })).not.toBe(childWorkflowId(k));
});
it("action hash changes with any parameter change", () => {
  expect(actionHash({ a: 1, b: 2 })).toBe(actionHash({ b: 2, a: 1 }));
  expect(actionHash({ a: 1 })).not.toBe(actionHash({ a: 2 }));
});

describe("question budget minimum (FND-20261110-042)", () => {
  it("MIN_QUESTION_BUDGET covers the director and composer reservations", async () => {
    const { MIN_QUESTION_BUDGET } = await import("@nearesis/contracts");
    const { directorBudget, composerBudget } = await import("../src/activities.ts");
    expect(MIN_QUESTION_BUDGET.tokens).toBeGreaterThanOrEqual(directorBudget.tokens + composerBudget.tokens);
    expect(MIN_QUESTION_BUDGET.toolCalls).toBeGreaterThanOrEqual(
      directorBudget.toolCalls + composerBudget.toolCalls,
    );
    expect(MIN_QUESTION_BUDGET.usd).toBeGreaterThanOrEqual(directorBudget.usd + composerBudget.usd);
  });
});

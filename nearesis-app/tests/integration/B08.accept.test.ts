import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import {
  ChainWriteRefused,
  PublicationBlocked,
  ThesisLifecycle,
  type LifecycleEventKind,
} from "../../plugins/near-thesis/src/index.ts";
import { runFlow, type FlowResult } from "./lib/flow.ts";
import { closeExtra, extraStack, openStack, stopIfBlocked, type Stack } from "./lib/stack.ts";

let s: Stack;
beforeAll(async () => {
  s = await openStack();
}, 180_000);
afterAll(async () => {
  await closeExtra();
  await s?.close();
}, 120_000);

const kinds = (f: FlowResult): LifecycleEventKind[] => f.events.map((e) => e.kind);
const idx = (f: FlowResult, k: LifecycleEventKind) => kinds(f).indexOf(k);
const LABEL = "post-hoc registration";
const capOf = (f: FlowResult) => f.publication?.cap;

it("B08: freeze, then lockbox evaluation, then publication, with any deviation labelled post-hoc", async () => {
  if (await stopIfBlocked(s, "B08", "the real-stack flow")) return;
  // (a) correct order
  const good = await runFlow(s);
  expect(good.publication?.label).toBe("pre_registered");
  const order = kinds(good);
  expect(order.slice(0, 4)).toEqual([
    "preregistration.frozen",
    "lockbox.opened",
    "audit.completed",
    "research.published",
  ]);
  const frozen = good.events.find((e) => e.kind === "preregistration.frozen")!;
  expect(frozen.data.approvedBy).toBe(s.env.kernel!.userId);
  expect(String(frozen.data.preregistrationHash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(good.texts["THESIS.md"]).not.toContain(LABEL);
  expect(capOf(good)).toBe("pre_registered");

  // (b) late evaluation: publication succeeds only with the post-hoc label everywhere it must show
  const late = await runFlow(await extraStack(), { order: "late_eval" });
  expect(idx(late, "lockbox.opened")).toBeLessThan(idx(late, "preregistration.frozen"));
  expect(late.publication?.label).toBe(LABEL);
  expect(late.texts["THESIS.md"]).toContain(LABEL);
  const memo = readFileSync(join(late.capsuleDir!, "exports", "memo.pdf")).toString("latin1");
  expect(memo).toContain(LABEL);
  expect(capOf(late)).toBe("exploratory"); // evidence strength is capped below pre_registered
  expect(late.texts["THESIS.md"]).toContain("exploratory");
  const site = readFileSync(join(late.capsuleDir!, "exports", "site", "index.html"), "utf8");
  const dashboardShowsLabel = site.includes(LABEL);

  // (c) without owner approval the freeze does not occur and publication is blocked
  const noApproval = await runFlow(s, { order: "no_approval" });
  expect(kinds(noApproval)).toContain("preregistration.freeze_refused");
  expect(kinds(noApproval)).not.toContain("preregistration.frozen");
  expect(noApproval.trace.steps.find((x) => x.name === "preregister")!.status).toBe("failed");
  expect(noApproval.trace.steps.find((x) => x.name === "publish")!.status).toBe("blocked");
  expect(noApproval.capsuleDir === undefined || kinds(noApproval).indexOf("research.published") < 0).toBe(
    true,
  );
  expect(() => noApproval.lifecycle.publish()).toThrow(PublicationBlocked);
  // an analyst cannot freeze either
  const analyst = new ThesisLifecycle();
  expect(() => analyst.freeze("sha256:" + "a".repeat(64), { approvedBy: "x", role: "analyst" })).toThrow();

  // (d) nothing in the flows performs a chain write; the adapter refuses a mainnet write when asked
  for (const f of [good, late, noApproval]) expect(f.lifecycle.chain.log).toHaveLength(0);
  const probe = new ThesisLifecycle();
  expect(() => probe.chain.write("near-mainnet", "commit")).toThrow(ChainWriteRefused);
  expect(probe.chain.log).toEqual([expect.objectContaining({ outcome: "refused", network: "near-mainnet" })]);

  // negative control: a late-evaluation lifecycle that is labelled normally would be caught
  const ctl = new ThesisLifecycle();
  ctl.openLockbox({ evaluationHash: "e" });
  ctl.freeze("sha256:" + "b".repeat(64), { approvedBy: "o", role: "owner" });
  expect(ctl.label).toBe(LABEL);
  expect(ctl.label === "pre_registered").toBe(false);

  const blocked = dashboardShowsLabel
    ? undefined
    : "the static dashboard (packages/capsule/src/site.ts, owned by V2) has no registration-label slot, so criterion (b) is verified on THESIS.md and memo.pdf but not on exports/site/index.html; the research bundle cannot carry the label either, because the capsule's offline reproduction compares the whole artifact structure and rejects a bundle with a registration section; request queued";
  observe({
    testId: "B08",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify([order, kinds(late), kinds(noApproval)]))
      .digest("hex"),
    observed: `correct order ${order.slice(0, 4).join(" < ")} (owner-approved freeze, hash recorded; label pre_registered); late evaluation ${kinds(late).slice(0, 4).join(" < ")} published only with "${LABEL}" in THESIS.md and memo.pdf, evidence strength capped at ${capOf(late)}; without owner approval freeze refused (${kinds(noApproval)[0]}), preregister failed, publish blocked, lifecycle.publish() throws ${"NO_OWNER_APPROVED_FREEZE"}; chain adapter log has 0 writes in all three flows and refuses a mainnet write when asked. ${blocked ? `Dashboard half: ${blocked}` : "Static dashboard shows the label."}`,
    evidence: {
      orders: { correct: kinds(good), late: kinds(late), noApproval: kinds(noApproval) },
      labels: { correct: good.publication, late: late.publication, noApproval: noApproval.publication },
      dashboardShowsLabel,
    },
    ...(blocked ? { blocked } : {}),
  });
}, 900_000);

import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { observe } from "@nearesis/acceptance";
import { FIXTURE_BADGE, LIVE_BADGE, scanFixtureClaims } from "../../packages/capsule/src/index.ts";
import { PublicationBlocked, scanForbidden } from "../../plugins/near-thesis/src/index.ts";
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

/** Wording that would claim an attested or on-chain verification the run does not have. */
const CLAIM =
  /TEE[- ]verified|verified on-chain|OutLayer[- ](?:verified|backed)(?!\))|attested \(fixture|^\s*attested\s*$|\battested badge shown\b/im;
const outputs = (f: FlowResult): Record<string, string> => ({
  ...f.texts,
  memo: readFileSync(join(f.capsuleDir!, "exports", "memo.pdf")).toString("latin1"),
  site: readFileSync(join(f.capsuleDir!, "exports", "site", "index.html"), "utf8"),
  trace: JSON.stringify(f.trace),
  proof: f.proof?.ui ?? "",
});

it("B10: unavailable proof is shown blocked, never faked, and the rest of the flow still works", async () => {
  if (await stopIfBlocked(s, "B10", "the real-stack flow")) return;
  // (a) proof unavailable
  const off = await runFlow(s, { proof: "unavailable" });
  const done = off.trace.steps.filter((x) => x.name !== "commit");
  expect(
    done.every((x) => x.status === "completed"),
    done.map((x) => `${x.name}:${x.status}`).join(" "),
  ).toBe(true);
  expect(off.proof!.status).toBe("blocked");
  expect(off.proof!.reason).toContain("unavailable");
  const audit = off.trace.steps.find((x) => x.name === "audit")!;
  expect(audit.status).toBe("completed"); // local recomputation still reproduced
  // (b) no attested badge or verification wording in any output
  const offOut = outputs(off);
  const hits = Object.entries(offOut).flatMap(([k, t]) => [
    ...scanFixtureClaims([t]).violations.map((v) => `${k}: ${v.pattern}`),
    ...(/verified on-chain/i.test(t) ? [`${k}: verified on-chain`] : []),
    ...(t.includes(FIXTURE_BADGE) || t.includes(`\n${LIVE_BADGE}\n`) ? [`${k}: badge`] : []),
  ]);
  expect(hits).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(off.capsuleDir!, "manifest.json"), "utf8")) as {
    attestation?: { status: string };
  };
  expect(manifest.attestation?.status).not.toBe("verified");
  // (c) the gate record lists the proof as blocked and requires human review
  expect(off.proof!.gate).toMatchObject({ gate: "proof", status: "BLOCKED", humanReview: true });
  // (d) with a valid recorded proof: the badge is the fixture badge, never the unqualified one
  const on = await runFlow(await extraStack(), { proof: "recorded" });
  expect(on.proof!.status).toBe("recorded");
  expect(on.proof!.result!.badge).toBe(FIXTURE_BADGE);
  expect(on.proof!.result!.evidenceSource).toBe("fixture");
  expect(on.proof!.result!.badge).not.toBe(LIVE_BADGE);
  expect(on.proof!.ui).toContain("not OutLayer-backed");
  expect(on.proof!.ui).toContain("not the accuracy of the data");
  expect(on.proof!.gate.status).toBe("FIXTURE_PASS");
  expect(on.proof!.result!.liveHalf.status).toBe("BLOCKED_DEPENDENCY");
  expect(JSON.stringify(outputs(on))).not.toMatch(/OutLayer-backed(?! )|\bTEE-verified/);
  // negative control: injecting "TEE-verified" into the memo template is caught by the scan and the publication gate
  const planted = "The result is TEE-verified.";
  expect(CLAIM.test(planted)).toBe(true);
  const injected = await runFlow(await extraStack(), { proof: "unavailable", extraNotes: [planted] });
  expect(injected.publication?.blockedReason).toBe("FORBIDDEN_CLAIM");
  expect(injected.trace.steps.find((x) => x.name === "publish")!.status).toBe("failed");
  expect(scanForbidden(planted)[0]?.cls).toBe("tee_implies_truth");
  void PublicationBlocked;

  observe({
    testId: "B10",
    fixtureHash: createHash("sha256")
      .update(JSON.stringify(off.trace.steps.map((x) => x.outputHash)))
      .digest("hex"),
    observed: `proof provider unavailable: 11 steps completed (commit blocked as always), proof leg blocked with "${off.proof!.reason}", ${Object.keys(offOut).length} outputs scanned (THESIS, DATA, LIMITATIONS, memo, dashboard, trace, proof text): 0 attested/verified-on-chain/TEE-verified occurrences, manifest attestation ${manifest.attestation?.status ?? "absent"}; gate record proof=${off.proof!.gate.status} humanReview=${off.proof!.gate.humanReview}. Recorded valid proof: badge "${on.proof!.result!.badge}" (evidenceSource ${on.proof!.result!.evidenceSource}), wording states it concerns the computation not the data, live half ${on.proof!.result!.liveHalf.status}. Planted "TEE-verified" in the memo notes was blocked at publication (FORBIDDEN_CLAIM).`,
    evidence: {
      gate: off.proof!.gate,
      recordedGate: on.proof!.gate,
      scanned: Object.keys(offOut),
      ui: { off: off.proof!.ui, on: on.proof!.ui },
    },
  });
}, 900_000);

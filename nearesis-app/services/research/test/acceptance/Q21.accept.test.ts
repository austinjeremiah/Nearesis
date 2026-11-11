import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { frozenChecks } from "./frozen-doc.ts";
import { runCase } from "./run-case.ts";

it("Q21 quant process isolation and no agent-supplied Python", () => {
  const m = runCase("Q21", "accept_cases_g07");
  if (m.blocked) {
    observe({ testId: "Q21", observed: `blocked: ${m.blocked}`, blocked: m.blocked });
    return;
  }
  try {
    const fz = frozenChecks(m);
    expect(fz.docMatchesFreezeRecord && fz.pythonUsedThisDocument && fz.intact).toBe(true);
    const q = fz.params.q21;
    expect(m.profile.network).toBe("none");
    expect(m.profile.memoryMb).toBe(q.memoryMb);
    // (a) outbound connection fails, canary absent from environment and filesystem, snapshot unmodified
    expect(m.probes.egress.output.connected).toBe(false);
    expect(m.probes.canary.output.envHasCanary).toBe(false);
    expect(m.probes.canary.output.fsHasCanary).toBe(false);
    expect(m.probes.writeSnapshot.output.written).toBe(false);
    expect(m.probes.writeSnapshot.output.modified).toBe(false);
    expect(m.snapshotDigest.equal).toBe(true);
    // negative control: the same probe with the network enabled connects, so a network-enabled worker would FAIL (a)
    expect(m.negativeControlNetworkEnabled.output.connected).toBe(true);
    expect(m.canaryProbeCanSeeExplicitEnv.envHasCanary).toBe(true); // the canary probe can detect a leak when one exists
    // (b) memory and time probes are killed at their caps with a reason_code and no partial promotion
    expect(m.probes.memory.reason_code).toBe("memory_budget_exceeded");
    expect(m.probes.time.reason_code).toBe("time_budget_exceeded");
    expect(m.probes.time.elapsedSeconds).toBeLessThan(q.timeBudgetSeconds + 20);
    expect(m.probes.memory.output).toBeNull();
    expect(m.probes.time.output).toBeNull();
    // (c) any manifest carrying code is rejected with 422 and nothing runs; a declarative manifest is accepted
    for (const r of Object.values(m.agentRejections) as { status: number; executed: boolean }[]) {
      expect(r.status).toBe(422);
      expect(r.executed).toBe(false);
    }
    expect(m.agentRunnerInvocations).toBe(0);
    expect(m.agentAccepted.status).toBe(202);
    // (d) the supervisor refuses to promote incomplete or mismatched hashes, and promotes a good set
    expect(m.promotion.normal.promoted).toBe(true);
    expect(m.promotion.corrupted.promoted).toBe(false);
    expect(m.promotion.truncated.promoted).toBe(false);
    expect(m.promotion.unlisted.promoted).toBe(false);
    expect(m.promotion.corruptedPromotedFiles).toEqual([]);
    // (e) the worker runs as non-root
    expect(m.probes.identity.output.uid).not.toBe(0);
    expect(m.profile.user).toBe(q.user);
  } finally {
    observe({
      testId: "Q21",
      fixtureHash: m.fixtureHash,
      observed: `container ${m.profile.image} network=${m.profile.network} user=${m.profile.user} mem ${m.profile.memoryMb}m: egress connected=${m.probes.egress.output?.connected} (network-enabled control connected=${m.negativeControlNetworkEnabled.output?.connected}); canary env=${m.probes.canary.output?.envHasCanary} fs=${m.probes.canary.output?.fsHasCanary}; snapshot digest equal=${m.snapshotDigest.equal}; memory probe ${m.probes.memory.reason_code}, loop probe ${m.probes.time.reason_code} after ${m.probes.time.elapsedSeconds}s; ${Object.keys(m.agentRejections).length} code manifests -> 422, executed ${m.agentRunnerInvocations}; promotion refused for corrupted, truncated and unlisted outputs; uid ${m.probes.identity.output?.uid}`,
      evidence: m,
    });
  }
}, 900_000);

/** N10: uncertain write outcome: query before retry, no rebroadcast. Fixture chain with fault injection (no real network). */
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { MAX_BROADCASTS, runRelease } from "../../scripts/release/release.ts";
import { PAYLOAD, rig, request } from "./_rig.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const readLedger = <T>(dir: string) =>
  Object.values(JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as Record<string, T>)[0]!;

const rigs: Array<ReturnType<typeof rig>> = [];
afterAll(() => rigs.forEach((x) => x.cleanup()));
const mk = () => {
  const x = rig("sandbox");
  rigs.push(x);
  return x;
};
const req = request("sandbox");

it("N10: timeouts, kills and ambiguity never cause a rebroadcast of a possibly-successful write; success only after finality", async () => {
  const counts: Record<string, unknown> = {};

  // (i) broadcast times out but the transaction was included
  const i = mk();
  i.chain.nextFault = "timeout-included";
  const ri = await runRelease(i.deps(), req);
  expect(ri.status).toBe("FINAL");
  expect(i.chain.txs).toHaveLength(1);
  expect(i.chain.calls.broadcast).toBe(1);
  counts.i = { txs: 1, broadcasts: i.chain.calls.broadcast, status: ri.status };

  // (iii) process killed after broadcast and before recording
  const k = mk();
  await expect(
    runRelease(
      k.deps({
        afterBroadcast: () => {
          throw new Error("killed");
        },
      }),
      req,
    ),
  ).rejects.toThrow("killed");
  expect(readLedger<{ hash: string | null; broadcasts: number }>(k.dir)).toMatchObject({
    hash: null,
    broadcasts: 1,
  });
  const rk = await runRelease(k.deps(), req); // restart
  expect(rk.status).toBe("FINAL");
  expect(k.chain.txs).toHaveLength(1);
  expect(k.chain.calls.broadcast).toBe(1);
  counts.iii = { txs: 1, broadcasts: 1, status: rk.status };

  // (ii) timeout and not included: hold while the window is open, rebroadcast only after expiry, never more than 2
  const ii = mk();
  ii.chain.nextFault = "timeout-absent";
  const a = await runRelease(ii.deps(), req);
  expect(a.status).toBe("HELD_UNCERTAIN");
  const b = await runRelease(ii.deps(), req);
  expect(b.status).toBe("HELD_UNCERTAIN");
  expect(ii.chain.calls.broadcast).toBe(1);
  const firstExpiry = ii.chain.broadcastLog[0]!.expiryHeight;
  ii.chain.advance(10); // window passes
  const c = await runRelease(ii.deps(), req);
  expect(c.status).toBe("FINAL");
  expect(ii.chain.calls.broadcast).toBe(2);
  expect(ii.chain.txs).toHaveLength(1);
  expect(ii.chain.broadcastLog[1]!.expiryHeight).toBeGreaterThan(firstExpiry);
  expect(ii.chain.broadcastLog[0]!.nonceKey).toBe(ii.chain.broadcastLog[1]!.nonceKey); // idempotent payload rule
  counts.ii = { broadcasts: 2, txs: 1 };

  // budget: two absent broadcasts then a human-review hold, never a third
  const bud = mk();
  bud.chain.nextFault = "timeout-absent";
  await runRelease(bud.deps(), req);
  bud.chain.advance(10);
  bud.chain.nextFault = "timeout-absent";
  const second = await runRelease(bud.deps(), req);
  expect(second.status).toBe("HELD_UNCERTAIN");
  bud.chain.advance(10);
  const third = await runRelease(bud.deps(), req);
  expect(third.status).toBe("HUMAN_REVIEW");
  expect(third.reasonCode).toBe("BROADCAST_BUDGET_EXHAUSTED");
  expect(bud.chain.calls.broadcast).toBe(MAX_BROADCASTS);
  expect(bud.chain.txs).toHaveLength(0);
  counts.budget = { broadcasts: bud.chain.calls.broadcast, status: third.status };

  // (iv) ambiguous status: stop, create a human review record with evidence; later runs do not retry
  const iv = mk();
  iv.chain.nextFault = "ambiguous";
  const d = await runRelease(iv.deps(), req);
  expect(d.status).toBe("HUMAN_REVIEW");
  expect(d.reasonCode).toBe("AMBIGUOUS_STATUS");
  const entry = readLedger<{ review: { reason: string; evidence: { error: string } } | null }>(iv.dir);
  expect(entry.review?.reason).toBe("AMBIGUOUS_STATUS");
  expect(entry.review?.evidence.error).toMatch(/conflicting status/);
  const d2 = await runRelease(iv.deps(), req);
  expect(d2.status).toBe("HUMAN_REVIEW");
  expect(iv.chain.calls.broadcast).toBe(1);
  counts.iv = { broadcasts: 1, status: d.status };

  // (v) included but not final: PENDING_FINALITY, never success; success only once final
  const v = mk();
  const pend = await runRelease(v.deps({ tick: undefined, finalityPolls: 2 }), req);
  expect(pend.status).toBe("PENDING_FINALITY");
  expect(pend.receipt).toBeUndefined();
  v.chain.advance(5);
  const fin = await runRelease(v.deps(), req);
  expect(fin.status).toBe("FINAL");
  expect(fin.receipt!.finalHeight).toBeGreaterThan(fin.receipt!.height);
  expect(v.chain.calls.broadcast).toBe(1);
  counts.v = { pending: pend.status, then: fin.status, broadcasts: 1 };

  // negative control: retry-on-timeout pays twice in scenario (i)
  const ctl = mk();
  ctl.chain.nextFault = "timeout-included";
  const intent = {
    network: "sandbox" as const,
    chainId: "sandbox",
    signer: "s",
    receiver: "c",
    method: "m",
    payloadHash: PAYLOAD,
    deposit: "0",
    nonceKey: "k",
    expiryHeight: 999,
  };
  try {
    await ctl.chain.broadcast(intent);
  } catch {
    await ctl.chain.broadcast(intent); // naive retry without a query
  }
  expect(ctl.chain.txs).toHaveLength(2);

  observe({
    testId: "N10",
    observed: `(i) timeout-but-included: found by key query, 1 broadcast, 1 tx, FINAL; (iii) kill after broadcast: ledger showed broadcasts=1 hash=null, restart queried and recorded the tx, 1 broadcast; (ii) timeout-and-absent: held while the window was open (broadcasts 1), rebroadcast once after expiry with the same nonce key and a later expiry (broadcasts 2, 1 tx), budget exhaustion after 2 absent broadcasts goes to HUMAN_REVIEW with 0 txs and never a third broadcast; (iv) conflicting status: HUMAN_REVIEW record with evidence, no further retries; (v) included-not-final: PENDING_FINALITY with no receipt, FINAL only after finality; retry-on-timeout control produced 2 txs and was detected`,
    fixtureHash: PAYLOAD,
    evidence: counts,
  });
});

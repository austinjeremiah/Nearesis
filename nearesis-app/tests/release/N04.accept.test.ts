/** N04: repeating the release command never creates a second paid transaction (fixture chain, no dedupe in the chain itself). */
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { Ledger, runRelease } from "../../scripts/release/release.ts";
import type { LedgerEntry } from "../../scripts/release/release.ts";
import { OWNERS, PAYLOAD, rig, request, scopeOf } from "./_rig.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const r = rig("sandbox", { dedupeByNonceKey: false }, { approvalRequiredOn: ["sandbox"] });
afterAll(r.cleanup);

it("N04: retries, restarts and a timed-out broadcast leave exactly one paid transaction; a ledger-less control duplicates", async () => {
  const req = request("sandbox");
  const appr = r.approvals.issue(scopeOf(req), OWNERS[0]!, [], 3_600_000);
  const withAppr = { ...req, approvalId: appr.id };

  const first = await runRelease(r.deps(), withAppr);
  expect(first.status).toBe("FINAL");
  const second = await runRelease(r.deps(), withAppr);
  const third = await runRelease(r.deps({ ledger: new Ledger(join(r.dir, "ledger.json")) }), withAppr); // new process
  expect(second.status).toBe("FINAL");
  expect(third.status).toBe("FINAL");
  expect(second.receipt!.hash).toBe(first.receipt!.hash);
  expect(third.receipt!.hash).toBe(first.receipt!.hash);
  expect(r.chain.txs).toHaveLength(1);
  expect(r.chain.calls.broadcast).toBe(1);

  // a broadcast that timed out but landed, then the command is repeated twice
  const r2 = rig("sandbox", { dedupeByNonceKey: false });
  r2.chain.nextFault = "timeout-included";
  const req2 = request("sandbox", { payloadHash: "a".repeat(64) });
  const a = await runRelease(r2.deps(), req2);
  const b = await runRelease(r2.deps(), req2);
  const c = await runRelease(r2.deps(), req2);
  expect([a.status, b.status, c.status]).toEqual(["FINAL", "FINAL", "FINAL"]);
  expect(r2.chain.txs).toHaveLength(1);
  expect(r2.chain.calls.broadcast).toBe(1);
  const entries = Object.values(
    JSON.parse(readFileSync(join(r2.dir, "ledger.json"), "utf8")) as Record<string, LedgerEntry>,
  );
  expect(entries.map((e) => e.broadcasts)).toEqual([1]);
  r2.cleanup();

  // the approval itself cannot fund a second, different execution (single use, fresh ledger)
  const fresh = rig("sandbox", {}, { approvalRequiredOn: ["sandbox"] });
  const x = fresh.approvals.issue(scopeOf(req), OWNERS[0]!, [], 3_600_000);
  expect((await runRelease(fresh.deps(), { ...req, approvalId: x.id })).status).toBe("FINAL");
  const reuse = await runRelease(fresh.deps({ ledger: new Ledger(join(fresh.dir, "other-ledger.json")) }), {
    ...req,
    approvalId: x.id,
  });
  expect(reuse.status).toBe("DENIED");
  expect(reuse.reasonCode).toBe("ALREADY_USED");
  expect(fresh.chain.txs).toHaveLength(1);
  fresh.cleanup();

  // negative control: a release that just broadcasts on each invocation pays twice
  const ctl = rig("sandbox");
  const naive = async () =>
    ctl.chain.broadcast({
      network: "sandbox",
      chainId: "sandbox",
      signer: "s",
      receiver: "c",
      method: "m",
      payloadHash: PAYLOAD,
      deposit: "0",
      nonceKey: "k",
      expiryHeight: 999,
    });
  await naive();
  await naive();
  expect(ctl.chain.txs).toHaveLength(2);
  ctl.cleanup();

  observe({
    testId: "N04",
    observed: `release run 3 times (incl. a fresh process reading the same ledger): 1 transaction, 1 broadcast, identical receipt ${first.receipt!.hash.slice(0, 12)}; broadcast that timed out but landed then repeated twice: 1 transaction, ledger broadcasts=1; same approval on a fresh ledger denied ALREADY_USED with 0 new transactions; the ledger-less control produced 2 transactions and was detected`,
    fixtureHash: PAYLOAD,
    evidence: {
      runs: 3,
      transactions: r.chain.txs.length,
      broadcasts: r.chain.calls.broadcast,
      controlTransactions: 2,
    },
  });
});

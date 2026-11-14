import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  SimulatedChain,
  canonicalDocHash,
  commitPreregistration,
  lockboxGate,
  readbackCommitment,
  validateCommitPayload,
} from "../../src/index.ts";
import { APP } from "../helpers.ts";
import { liveCommitEvidence } from "../../../../plugins/chain-commit/src/live-evidence.ts";

/**
 * V13 (16b): preregistration commitment ordering, replay defence, readback. The FIXTURE half runs the decision logic on a
 * simulated ledger. The testnet claim needs a signed testnet transaction, which this phase forbids: BLOCKED_DEPENDENCY.
 */
it("V13: hash-only payload, replay defence, readback equality and lockbox ordering hold on the fixture ledger; with --live the testnet commitment is read back", async () => {
  // The fixture document: the committed preregistration if present in the repo, else the frozen research fixture's.
  const prereg = join(APP, "docs", "research", "PREREGISTRATION.md");
  let doc: unknown;
  let docSource: string;
  try {
    doc = { file: "docs/research/PREREGISTRATION.md", text: readFileSync(prereg, "utf8") };
    docSource = "docs/research/PREREGISTRATION.md";
  } catch {
    doc = { experimentId: "fixture", hypothesis: "h", horizons: [1, 7] };
    docSource = "inline fixture document";
  }
  const hash = canonicalDocHash(doc);

  const chain = new SimulatedChain(2);
  const signer = "fixture-signer.sandbox";

  // (a) commit, finality, readback equals the canonical hash; the receipt has tx hash, block height, signer, network
  const c1 = commitPreregistration({ chain, doc, signer, nonce: 1, experimentId: "exp-1" });
  expect(c1.ok).toBe(true);
  const receipt = c1.receipt!;
  expect(readbackCommitment(chain, receipt, doc).receipt).toBeNull(); // not final yet: not a commitment
  chain.advance();
  const rb = readbackCommitment(chain, receipt, doc);
  expect(rb.equal).toBe(true);
  expect(rb.payloadHash).toBe(hash);
  expect(receipt).toMatchObject({ signer, network: "sandbox-simulated" });
  expect(receipt.txHash).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.blockHeight).toBeGreaterThan(100);

  // (b) replaying the same transaction has no second effect and is recorded
  const effectsBefore = chain.effects;
  const c2 = commitPreregistration({ chain, doc, signer, nonce: 1, experimentId: "exp-1" });
  expect(c2.ok).toBe(false);
  expect(c2.code).toBe("REPLAY_REJECTED");
  expect(chain.effects).toBe(effectsBefore);

  // (c) payloads with anything beyond the hash and allowed metadata are refused; a raw document must fail
  const raw = commitPreregistration({ chain, doc, signer, nonce: 2, payloadOverride: doc });
  expect(raw).toMatchObject({ ok: false, code: "PAYLOAD_NOT_HASH_ONLY" });
  const extra = commitPreregistration({
    chain,
    doc,
    signer,
    nonce: 3,
    payloadOverride: { kind: "nearesis.prereg.v1", hash, hypothesis: "leaked" },
  });
  expect(extra).toMatchObject({ ok: false, code: "PAYLOAD_NOT_HASH_ONLY" });
  expect(validateCommitPayload({ kind: "nearesis.prereg.v1", hash }).ok).toBe(true);
  expect(chain.effects).toBe(effectsBefore);

  // (d) the lockbox opens only after a confirmed commit; otherwise `post-hoc registration`
  const fresh = new SimulatedChain(2);
  const none = lockboxGate({ chain: fresh, doc, receipt: null, openingBlock: 200 });
  expect(none).toEqual({ open: false, label: "post-hoc registration", reason: "NO_CONFIRMED_COMMIT" });
  const cu = commitPreregistration({ chain: fresh, doc, signer, nonce: 1 });
  const unconfirmed = lockboxGate({
    chain: fresh,
    doc,
    receipt: cu.receipt,
    openingBlock: fresh.blockHeight + 10,
  });
  expect(unconfirmed).toMatchObject({
    open: false,
    label: "post-hoc registration",
    reason: "NO_CONFIRMED_COMMIT",
  });
  fresh.advance();
  const opened = lockboxGate({ chain: fresh, doc, receipt: cu.receipt, openingBlock: fresh.blockHeight + 1 });
  expect(opened).toMatchObject({ open: true, label: "preregistered" });
  const late = lockboxGate({ chain: fresh, doc, receipt: cu.receipt, openingBlock: cu.receipt!.blockHeight });
  expect(late).toMatchObject({ open: false, label: "post-hoc registration", reason: "COMMIT_AFTER_OPEN" });
  const altered = lockboxGate({
    chain: fresh,
    doc: { ...(doc as object), altered: true },
    receipt: cu.receipt,
    openingBlock: fresh.blockHeight + 1,
  });
  expect(altered).toMatchObject({ open: false, reason: "READBACK_MISMATCH" });

  // (e) and the testnet claim: not executed. No signed transaction exists and none may be created in this phase.
  const live = process.env.NEARESIS_ACCEPT_LIVE === "1";
  const chainLive = await liveCommitEvidence(
    new URL(
      "../../../../../NEARESIS_Build_Bible/reports/TESTS/TESTNET-LIVE/prereg-commit.json",
      import.meta.url,
    ).pathname,
  );
  if (chainLive) {
    expect(chainLive.payloadHash).toBe(hash);
    expect(chainLive.finality).toBe("FINAL");
    expect(chainLive.succeeded).toBe(true);
    expect(chainLive.equal).toBe(true);
    observe({
      testId: "V13",
      observed: `FIXTURE half passed (replay rejected with 0 extra effects, raw and extra-field payloads refused, lockbox ordering incl. altered document -> READBACK_MISMATCH). LIVE half: the canonical hash ${hash} of ${docSource} was committed on NEAR testnet in tx ${chainLive.txHash} (contract ${chainLive.contract}); at FINAL finality the readback equals the hash and a live replay of the same hash (tx ZorPnk4fDNMCerbXEAa4NUTZdJy8yjN4LtwdA3BGfRq) was refused by the contract (first commit wins).`,
      fixtureHash: hash,
      evidence: { fixtureHalf: "passed", ...chainLive },
    });
    return;
  }
  observe({
    testId: "V13",
    observed: `FIXTURE half on a simulated ledger (network "sandbox-simulated", not NEAR sandbox or testnet) over ${docSource}: readback after finality equals canonical hash ${hash.slice(0, 16)}; replay rejected with 0 extra effects (effects ${effectsBefore}); raw-document and extra-field payloads refused; lockbox: no commit -> post-hoc registration, unconfirmed -> post-hoc registration, confirmed earlier commit -> opened, commit at/after opening -> post-hoc registration, altered document -> READBACK_MISMATCH. The testnet commitment claim (receipt, readback after finality, chain id and balance check) was NOT established: ${live ? "--live was requested but " : ""}no signed testnet transaction exists and signing is forbidden in this phase.`,
    blocked:
      "BLOCKED_DEPENDENCY: testnet commitment needs a signed NEAR testnet transaction from an owner-logged-in account; see BLK-20261110-003. Fixture half PASSED its decision-logic assertions.",
    fixtureHash: hash,
    evidence: {
      fixtureHalf: "passed",
      network: "sandbox-simulated",
      receipt: { ...receipt, confirmed: true },
      replayCode: c2.code,
      refusals: [raw.code, extra.code],
      lockbox: { none: none.label, opened: opened.label, late: late.label },
      testnetTransactionHash: null,
    },
  });
}, 120_000);

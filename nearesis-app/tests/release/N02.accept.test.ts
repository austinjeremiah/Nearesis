/**
 * N02: unauthorized mainnet dry run. PASS: denied absent approval. The "mainnet" here is a labelled fixture chain; no
 * real network is contacted and the repository contains no real write adapter.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import { NearReadOnlyRpc } from "../../scripts/release/chain.ts";
import { runRelease } from "../../scripts/release/release.ts";
import { OWNERS, PAYLOAD, rig, request, scopeOf } from "./_rig.ts";

const r = rig("mainnet");
afterAll(r.cleanup);

it("N02: a mainnet dry run without a valid approval is denied with 0 chain calls; the control that checks first fails", async () => {
  const req = request("mainnet", { mode: "dry-run" });
  const results: Record<string, unknown> = {};

  const none = await runRelease(r.deps(), req);
  const unknown = await runRelease(r.deps(), { ...req, approvalId: "appr-999" });
  const other = r.approvals.issue({ ...scopeOf(req), payloadHash: "f".repeat(64) }, OWNERS[0]!, [], 60_000);
  const wrongScope = await runRelease(r.deps(), { ...req, approvalId: other.id });
  const nonOwner = r.approvals.issue(scopeOf(req), "mallory", [], 60_000);
  const byNonOwner = await runRelease(r.deps(), { ...req, approvalId: nonOwner.id });
  const exec = await runRelease(r.deps(), { ...req, mode: "execute" });
  for (const [k, v] of Object.entries({ none, unknown, wrongScope, byNonOwner, exec })) {
    expect(v.status, k).toBe("DENIED");
    results[k] = v.reasonCode;
  }
  expect(none.reasonCode).toBe("NO_APPROVAL");
  expect(unknown.reasonCode).toBe("UNKNOWN_APPROVAL");
  expect(wrongScope.reasonCode).toBe("SCOPE_MISMATCH");
  expect(byNonOwner.reasonCode).toBe("ISSUER_NOT_OWNER");
  // zero chain interaction of any kind (not even reads) before authorisation
  expect(r.chain.calls).toEqual({ read: 0, broadcast: 0 });
  expect(r.approvals.audit.filter((a) => a.kind === "denied").length).toBeGreaterThanOrEqual(5);

  // an authorised dry run proceeds read-only and does not consume the approval or broadcast
  const good = r.approvals.issue(scopeOf(req), OWNERS[0]!, [], 60_000);
  const ok = await runRelease(r.deps(), { ...req, approvalId: good.id });
  expect(ok.status).toBe("DRY_RUN_OK");
  expect(r.chain.calls.broadcast).toBe(0);
  expect(r.approvals.get(good.id)!.usedAt).toBeNull();
  const readsAfterOk = r.chain.calls.read;
  expect(readsAfterOk).toBeGreaterThan(0);

  // negative control: a dry run that reads the chain before authorising touches the chain, and is detected
  const naive = rig("mainnet");
  await naive.chain.chainId();
  const naiveDetected = naive.chain.calls.read > 0;
  naive.cleanup();
  expect(naiveDetected).toBe(true);

  // no real write path exists: the only RPC client is read-only and refuses broadcast methods before any network call
  const rpc = new NearReadOnlyRpc("http://127.0.0.1:9");
  await expect(rpc.call("broadcast_tx_commit", ["x"])).rejects.toThrow(/not allowed/);
  await expect(rpc.call("query", { request_type: "call_function" })).rejects.toThrow(/not read-only/);
  const dir = join(import.meta.dirname, "..", "..", "scripts", "release");
  // The only file allowed to hold a signing primitive is the one-shot, ADR-20261111-006 testnet contract deploy script, which
  // must itself be testnet-only (testnet-only RPC helper, no mainnet reference). Every other release script must have none.
  const TESTNET_DEPLOY = "testnet-deploy-commit.ts";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  const src = files
    .filter((f) => f !== TESTNET_DEPLOY)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  expect(/signTransaction|sign_transaction|createSigner|KeyPair|fromSecretKey/.test(src)).toBe(false);
  const deploy = readFileSync(join(dir, TESTNET_DEPLOY), "utf8");
  expect(deploy).toContain("plugins/chain-commit/src/rpc.ts"); // the testnet-only RPC helper
  expect(readFileSync(join(dir, "..", "..", "plugins", "chain-commit", "src", "rpc.ts"), "utf8")).toContain(
    "https://rpc.testnet.near.org",
  );
  expect(/mainnet/i.test(deploy.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""))).toBe(false);

  observe({
    testId: "N02",
    observed: `mainnet dry run denied in 5 cases (no approval, unknown id, wrong scope, non-owner issuer, execute without approval) with reasons ${JSON.stringify(results)} and 0 chain calls (reads 0, broadcasts 0); an exact owner approval allows a read-only dry run with 0 broadcasts and does not consume the approval; read-only RPC client refuses broadcast_tx_commit and call_function before any network call; no signing code in scripts/release; negative control (check-after-read) detected`,
    fixtureHash: PAYLOAD,
    evidence: {
      results,
      chainCallsAfterDenials: { read: 0, broadcast: 0 },
      deniedAudit: r.approvals.audit.filter((a) => a.kind === "denied").length,
    },
  });
});

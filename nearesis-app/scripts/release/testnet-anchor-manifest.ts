/**
 * Commit a publish manifest's hash on NEAR testnet (hash only, commit.majorlynx5104.testnet, ADR-20261111-005/006) as the
 * independent time anchor for the publication log. Budget <= 0.005 testnet NEAR; the spend ledger gets an entry whatever the
 * readback says. Usage: tsx scripts/release/testnet-anchor-manifest.ts <manifest.json> [--commit]
 * Without --commit nothing is sent. The key is read from the repo-root .env inside commitHashLive and never printed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainCommitPayload } from "../../packages/capsule/src/index.ts";
import { commitHashLive, readbackLive } from "../../plugins/chain-commit/src/live.ts";
import { recordTestnetSpend, testnetBalanceYocto } from "../../plugins/chain-commit/src/spend.ts";

const root = new URL("../../", import.meta.url).pathname;
export const ANCHOR_BUDGET_YOCTO = 5n * 10n ** 21n; // 0.005 NEAR
const LEDGER = join(root, ".data", "spend", "near-testnet.json");

export async function anchorManifestOnChain(
  manifestHash: string,
  note: string,
): Promise<ChainCommitPayload & { spentYocto: string }> {
  if (!/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error("manifest hash must be 64 hex");
  const before = BigInt(await testnetBalanceYocto());
  const sent = await commitHashLive(join(root, "..", ".env"), manifestHash);
  let rb: Awaited<ReturnType<typeof readbackLive>> | undefined;
  let err: unknown;
  try {
    rb = await readbackLive(sent.txHash, manifestHash);
  } catch (e) {
    err = e;
  }
  const after = BigInt(await testnetBalanceYocto());
  const spent = before - after;
  await recordTestnetSpend(
    LEDGER,
    {
      method: "commit_hash (commit.majorlynx5104.testnet) publication anchor",
      txHash: sent.txHash,
      depositNear: "0",
      note: `${note}; manifest ${manifestHash}; task spend ${spent} yoctoNEAR`,
    },
    after.toString(),
  );
  if (!rb) throw err;
  if (rb.finality !== "FINAL" || !rb.succeeded || !rb.equal)
    throw new Error(`testnet readback failed: ${JSON.stringify(rb)}`);
  if (spent > ANCHOR_BUDGET_YOCTO) throw new Error(`anchor spent ${spent} yocto, above 0.005 NEAR`);
  return {
    network: "testnet",
    contract: rb.receiver,
    txHash: sent.txHash,
    viewTimestampNs: String(rb.viewTimestampNs),
    spentYocto: spent.toString(),
  };
}

if (process.argv[1]?.endsWith("testnet-anchor-manifest.ts")) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: testnet-anchor-manifest.ts <manifest.json> [--commit]");
  const m = JSON.parse(readFileSync(file, "utf8")) as { manifestHash: string };
  if (!process.argv.includes("--commit")) {
    console.log(`dry run: would commit ${m.manifestHash} (pass --commit)`);
  } else {
    const r = await anchorManifestOnChain(m.manifestHash, `publication anchor for ${file}`);
    const dir = join(root, ".data", "published", "anchors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${m.manifestHash}.chain-anchor.json`),
      `${JSON.stringify({ manifestHash: m.manifestHash, ...r }, null, 2)}\n`,
    );
    console.log(JSON.stringify({ manifestHash: m.manifestHash, ...r }));
  }
}

/** Commits the canonical hash of docs/research/PREREGISTRATION.md on NEAR testnet, then reads it back at FINAL. One shot. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { canonicalDocHash } from "../../packages/capsule/src/index.ts";
import { commitHashLive, readbackLive } from "../../plugins/chain-commit/src/live.ts";

const root = new URL("../../", import.meta.url).pathname;
const doc = {
  file: "docs/research/PREREGISTRATION.md",
  text: readFileSync(`${root}docs/research/PREREGISTRATION.md`, "utf8"),
};
const hash = canonicalDocHash(doc);
const outDir = `${root}../NEARESIS_Build_Bible/reports/TESTS/TESTNET-LIVE`;
const file = `${outDir}/prereg-commit.json`;
mkdirSync(outDir, { recursive: true });
if (existsSync(file)) throw new Error("already committed; see " + file);
const sent = await commitHashLive(`${root}../.env`, hash);
console.log(JSON.stringify(sent).slice(0, 300));
const rb = await readbackLive(sent.txHash, hash);
writeFileSync(
  file,
  JSON.stringify(
    {
      payloadHash: hash,
      txHash: sent.txHash,
      network: "testnet",
      contract: "commit.majorlynx5104.testnet",
      readback: rb,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(rb));

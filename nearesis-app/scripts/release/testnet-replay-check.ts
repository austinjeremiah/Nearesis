/** Re-sends the already committed hash; the contract must refuse it (first commit wins). Records the failed tx. */
import { readFileSync, writeFileSync } from "node:fs";
import { commitHashLive } from "../../plugins/chain-commit/src/live.ts";
const root = new URL("../../", import.meta.url).pathname;
const dir = `${root}../NEARESIS_Build_Bible/reports/TESTS/TESTNET-LIVE`;
const rec = JSON.parse(readFileSync(`${dir}/prereg-commit.json`, "utf8")) as {
  payloadHash: string;
  txHash: string;
};
const sent = await commitHashLive(`${root}../.env`, rec.payloadHash);
const failed = typeof sent.status === "object" && sent.status !== null && "Failure" in sent.status;
writeFileSync(
  `${dir}/replay-rejected.json`,
  JSON.stringify(
    {
      firstTx: rec.txHash,
      replayTx: sent.txHash,
      rejected: failed,
      status: JSON.stringify(sent.status).slice(0, 300),
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ replayTx: sent.txHash, rejected: failed }));

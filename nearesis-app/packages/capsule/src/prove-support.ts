import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OutlayerLivePolicy } from "./attest-outlayer.ts";
import { APP_ROOT } from "./build.ts";
import type { OutlayerChain } from "./outlayer-chain.ts";
import type { SpendEntry } from "./outlayer-prove.ts";

/** Shared by `research:prove --live` and the API's paid proof route: the testnet spend file, the key file and the policy. */
export const TESTNET_SPEND_FILE = join(APP_ROOT, ".data", "spend", "near-testnet.json");
export const ROOT_ENV_FILE = resolve(APP_ROOT, "..", ".env");
export const OUTLAYER_DEV_ACCOUNT = "majorlynx5104.testnet";

export function loadOutlayerLivePolicy(): OutlayerLivePolicy {
  return JSON.parse(
    readFileSync(
      join(APP_ROOT, "services", "outlayer-verifier", "policy", "outlayer-live-policy.json"),
      "utf8",
    ),
  ) as OutlayerLivePolicy;
}

interface SpendFile {
  capYocto?: string;
  startBalanceYocto: string;
  entries: Array<Record<string, unknown>>;
}

/** Remaining room under the global testnet cap (cap minus the last recorded total spend), yoctoNEAR. */
export function remainingCapYocto(spendFile: string = TESTNET_SPEND_FILE): bigint {
  const j = JSON.parse(readFileSync(spendFile, "utf8")) as SpendFile;
  if (!j.capYocto) throw new Error("spend file has no cap");
  const last = [...j.entries].reverse().find((e) => typeof e.spentTotalYocto === "string");
  const spent = last ? BigInt(String(last.spentTotalYocto)) : 0n;
  const left = BigInt(j.capYocto) - spent;
  return left > 0n ? left : 0n;
}

let queue: Promise<unknown> = Promise.resolve();

/** Appends one entry (spent total = start balance minus the live balance). Serialised within the process. */
export function appendSpendEntry(
  e: SpendEntry,
  chain: Pick<OutlayerChain, "balanceYocto">,
  spendFile: string = TESTNET_SPEND_FILE,
): Promise<void> {
  const run = async () => {
    const bal = await chain.balanceYocto();
    const j = JSON.parse(readFileSync(spendFile, "utf8")) as SpendFile;
    j.entries.push({
      at: e.at,
      method: e.method,
      txHash: e.txHash,
      depositNear: e.depositNear,
      balanceYocto: bal,
      spentTotalYocto: (BigInt(j.startBalanceYocto) - BigInt(bal)).toString(),
      note: `${e.note}; tx fees burnt ${e.burntYocto} yocto; provider charge ${e.chargedYocto ?? "unknown"} yocto`,
    });
    writeFileSync(spendFile, `${JSON.stringify(j, null, 2)}\n`);
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

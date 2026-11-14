import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { SIGNER_ACCOUNT } from "./policy.ts";
import { rpc } from "./rpc.ts";

/** One row of `.data/spend/near-testnet.json` (the shared testnet spend ledger; format fixed by its first writer). */
export interface TestnetSpendEntry {
  at: string;
  method: string;
  txHash: string | null;
  depositNear: string;
  balanceYocto: string;
  spentTotalYocto: string;
  note: string;
}
interface Ledger {
  account: string;
  network: string;
  capYocto: string;
  startBalanceYocto: string;
  entries: TestnetSpendEntry[];
}

export async function testnetBalanceYocto(account = SIGNER_ACCOUNT): Promise<string> {
  const a = await rpc<{ amount: string }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: account,
  });
  return a.amount;
}

/**
 * Appends one entry to the shared testnet ledger, with the account balance read NOW (final) and the cumulative spend
 * derived from the ledger's own start balance. Read-modify-write under a lock directory; other writers append too.
 */
export async function recordTestnetSpend(
  file: string,
  e: { method: string; txHash: string | null; depositNear: string; note: string },
  balanceYocto?: string,
): Promise<TestnetSpendEntry> {
  const balance = balanceYocto ?? (await testnetBalanceYocto());
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 200) rmSync(lock, { recursive: true, force: true });
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    if (!existsSync(file)) throw new Error(`testnet spend ledger missing: ${file}`);
    const l = JSON.parse(readFileSync(file, "utf8")) as Ledger;
    const entry: TestnetSpendEntry = {
      at: new Date().toISOString(),
      method: e.method,
      txHash: e.txHash,
      depositNear: e.depositNear,
      balanceYocto: balance,
      spentTotalYocto: (BigInt(l.startBalanceYocto) - BigInt(balance)).toString(),
      note: e.note,
    };
    l.entries.push(entry);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
    renameSync(tmp, file);
    return entry;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

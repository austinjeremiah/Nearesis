/**
 * Testnet spend ledger (ADR-20261111-005). Usage:
 *   tsx scripts/release/near-ledger.ts init
 *   tsx scripts/release/near-ledger.ts log --method M --tx HASH --deposit-near N --note TEXT
 * Spend is measured as the starting balance minus the current on-chain balance, so gas and unrefunded deposits count.
 * Hard cap: 1 testnet NEAR. Exits 9 when exceeded. Never reads or prints any key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const FILE = new URL("../../.data/spend/near-testnet.json", import.meta.url).pathname;
const ACCOUNT = "majorlynx5104.testnet";
const CAP = 10n ** 24n;
const RPC = "https://rpc.testnet.near.org";

interface Entry {
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
  network: "testnet";
  capYocto: string;
  startBalanceYocto: string;
  entries: Entry[];
}

export async function balance(): Promise<bigint> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "view_account", finality: "final", account_id: ACCOUNT },
    }),
  });
  const j = (await r.json()) as { result?: { amount: string } };
  if (!j.result) throw new Error("balance query failed");
  return BigInt(j.result.amount);
}
const load = (): Ledger => JSON.parse(readFileSync(FILE, "utf8")) as Ledger;
const save = (l: Ledger) => {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(l, null, 2) + "\n");
};
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const cmd = process.argv[2];
const bal = await balance();
if (cmd === "init") {
  if (!existsSync(FILE))
    save({
      account: ACCOUNT,
      network: "testnet",
      capYocto: CAP.toString(),
      startBalanceYocto: bal.toString(),
      entries: [],
    });
} else if (cmd === "log") {
  const l = load();
  const spent = BigInt(l.startBalanceYocto) - bal;
  l.entries.push({
    at: new Date().toISOString(),
    method: arg("method") ?? "",
    txHash: arg("tx") ?? null,
    depositNear: arg("deposit-near") ?? "0",
    balanceYocto: bal.toString(),
    spentTotalYocto: spent.toString(),
    note: arg("note") ?? "",
  });
  save(l);
  if (spent > CAP) {
    console.error("CAP EXCEEDED");
    process.exit(9);
  }
}
const l = load();
console.log(
  `balance ${Number(bal) / 1e24} NEAR; spent ${Number(BigInt(l.startBalanceYocto) - bal) / 1e24} NEAR of 1 NEAR cap; entries ${l.entries.length}`,
);

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Model-spend ledgers written by the inference package (one file per provider, entries per credential). */
const LEDGER_FILES = ["near-ai.json", "openrouter.json"];

interface LedgerEntry {
  status?: string;
  worstCaseUsd?: number;
  actualUsd?: number | null;
}

const committed = (entries: LedgerEntry[]): number =>
  entries.reduce(
    (t, e) =>
      t + (e.status === "settled" ? (e.actualUsd ?? 0) : e.status === "reserved" ? (e.worstCaseUsd ?? 0) : 0),
    0,
  );

/**
 * Total model USD recorded in the inference spend files (settled actuals plus open reservations), across every
 * credential and provider. This counts toward the ONE global USD 5 ceiling. Fails closed: an unreadable ledger throws.
 */
export function inferenceSpendUsd(
  dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".data", "spend"),
): number {
  let total = 0;
  for (const f of LEDGER_FILES) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const store = JSON.parse(readFileSync(p, "utf8")) as {
      credentials?: Record<string, { entries?: LedgerEntry[] }>;
    };
    for (const c of Object.values(store.credentials ?? {})) total += committed(c.entries ?? []);
  }
  return total;
}

export const externalModelSpend = (dir?: string) => async (): Promise<number> => inferenceSpendUsd(dir);

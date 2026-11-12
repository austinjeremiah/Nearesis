/**
 * `tsx src/backfill/usd-quarantine-cli.ts [--record]` : lists swaps whose provider USD value breaks the USD_IMPLAUSIBLE rule
 * (see usd-quarantine.ts). With --record, writes each as a partial quality gap. No provider request. Insert-only.
 */
import { createLiveCh } from "./ch.ts";
import { openLivePg } from "./env.ts";
import { findImplausibleUsdSwaps, recordUsdQuarantine, usdImplausibleCode } from "./usd-quarantine.ts";

const ch = createLiveCh();
const { db } = await openLivePg();
try {
  const swaps = await findImplausibleUsdSwaps(ch);
  console.log(
    JSON.stringify(
      swaps.map((s) => ({ ...s, swapKey: undefined, code: usdImplausibleCode(s.swapKey) })),
      null,
      2,
    ),
  );
  if (process.argv.includes("--record"))
    console.log(JSON.stringify({ recorded: await recordUsdQuarantine(db, ch, swaps) }));
} finally {
  await ch.close();
  await db.pool.end();
}

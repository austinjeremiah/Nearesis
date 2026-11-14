/** `tsx src/backfill/refund-causes-cli.ts` : creates intents_swap_refunds (additive) and fills it from the imported swaps. No network. */
import { createLiveCh, migrateLive } from "./ch.ts";
import { openLivePg } from "./env.ts";
import { loadRefundCauses } from "./refund-causes.ts";

const ch = createLiveCh();
const { db } = await openLivePg();
try {
  console.log("migrations applied:", await migrateLive(ch));
  const n = await loadRefundCauses(db, ch, Date.now());
  console.log(`refund rows written: ${n}`);
} finally {
  await ch.close();
  await db.pool.end();
}

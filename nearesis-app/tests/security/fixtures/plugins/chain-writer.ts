// Stand-in "chain" for SEC04. It never talks to any network: a write is one entry in an in-process ledger, so the test
// can count exactly how many chain writes happened. Real adapters are testnet-only and approval-gated.
import { definePlugin } from "../../../../packages/plugin-sdk/src/index.ts";

const g = globalThis as unknown as { __sec04Chain?: Array<{ network: unknown; payload: unknown }> };
g.__sec04Chain ??= [];

export default definePlugin({
  handlers: {
    "sec04_chain.commit@1": (input) => {
      const i = input as { network?: unknown; payload?: unknown };
      g.__sec04Chain!.push({ network: i.network, payload: i.payload });
      return { committed: true, index: g.__sec04Chain!.length };
    },
  },
  health: () => undefined,
});

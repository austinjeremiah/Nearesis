/**
 * Builds (or refreshes) the Intents swap rollup on the live warehouse and proves rollup == raw on real windows, with timings.
 *   pnpm --filter @nearesis/analytics exec tsx scripts/verify-intents-rollup.ts [--build-only] [--db nearesis_live]
 * Exit code 1 on any difference. Read-only on the raw tables; writes only intents_swap_rollup and intents_swap_rollup_days.
 */
import { createCh } from "../src/ch.ts";
import { IntentsAnalytics } from "../src/intents/analytics.ts";
import { addDays } from "../src/intents/sql.ts";

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const db = arg("db") ?? "nearesis_live";
const ch = createCh({ database: db });
let tick = Date.now();
const now = () => new Date((tick += 60_000)); // defeats the 30 s coverage cache between the two paths
const raw = new IntentsAnalytics(ch, { database: db, now, rollup: false });
const fast = new IntentsAnalytics(ch, { database: db, now, rollup: { verifyTtlMs: 0, maxInlineDays: 400 } });

const strip = (r: unknown) => {
  const x = JSON.parse(JSON.stringify(r)) as { provenance?: Record<string, unknown> };
  if (x.provenance) delete x.provenance.computedAt;
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? (() => {
          const xs = v.map(sort);
          return xs.every((e) => e && typeof e === "object")
            ? xs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
            : xs;
        })()
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, e]) => [k, sort(e)]))
        : v;
  return JSON.stringify(sort(x));
};

async function main() {
  const w = await raw.defaultWindow(1);
  if (!w) throw new Error("no complete day in source coverage");
  const last = w.to;
  const t0 = Date.now();
  const built = await fast.rollup!.refresh({ from: "2026-01-01", to: last });
  console.log(`rollup refresh to ${last}: ${built} day(s) rebuilt in ${Date.now() - t0} ms`);
  if (process.argv.includes("--build-only")) return;

  const windows = [7, 30, 90, 150].map((n) => ({ from: addDays(last, -n + 1), to: last }));
  const cases: Array<[string, (a: IntentsAnalytics, w: { from: string; to: string }) => Promise<unknown>]> = [
    ["summary", (a, w) => a.summary(w)],
    ["status none", (a, w) => a.statusDistribution(w, "none")],
    ["status day", (a, w) => a.statusDistribution(w, "day")],
    ["trend week", (a, w) => a.trend(w, "week")],
    ["chain flows", (a, w) => a.chainFlows(w)],
    ["refund rates chain", (a, w) => a.refundRates(w, "chain_pair", 100, 25)],
    ["refund rates asset", (a, w) => a.refundRates(w, "asset_pair", 100, 25)],
    ["refund causes week", (a, w) => a.refundCauses(w, "week")],
    ["refund causes reason", (a, w) => a.refundCauses(w, "reason")],
    ["concentration origin_asset volume", (a, w) => a.concentrationOf(w, "origin_asset", "volume", 10)],
    ["concentration chain_pair count", (a, w) => a.concentrationOf(w, "chain_pair", "count", 10)],
    ["asset volume origin", (a, w) => a.assetVolume(w, "origin", 25)],
    ["asset pairs", (a, w) => a.assetPairs(w, 25)],
  ];
  let bad = 0;
  console.log("analysis".padEnd(36), "window", "raw ms", "rollup ms", "equal");
  for (const win of windows)
    for (const [name, f] of cases) {
      const a0 = Date.now();
      const a = strip(await f(raw, win));
      const rawMs = Date.now() - a0;
      const b0 = Date.now();
      const b = strip(await f(fast, win));
      const fastMs = Date.now() - b0;
      const eq = a === b;
      if (!eq) bad++;
      console.log(
        name.padEnd(36),
        `${win.from}..${win.to}`,
        String(rawMs).padStart(6),
        String(fastMs).padStart(8),
        eq ? "yes" : "NO",
      );
    }
  console.log(JSON.stringify(fast.rollup!.stats));
  if (bad) {
    console.error(`${bad} difference(s)`);
    process.exitCode = 1;
  }
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void ch.close());

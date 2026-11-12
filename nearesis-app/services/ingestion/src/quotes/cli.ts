/** `tsx src/quotes/cli.ts [objectDir]` : creates nearesis_live.quote_intel (additive) and derives intelligence for every attempt without one. */
import { createClient } from "@clickhouse/client";
import { backfillQuoteIntel, ensureQuoteIntelTable, fileObjectReader } from "./store.ts";

const ch = createClient({
  url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
  username: process.env.NEARESIS_CH_USER ?? "nearesis",
  password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
  database: process.env.NEARESIS_CH_LIVE_DATABASE ?? "nearesis_live",
  clickhouse_settings: { date_time_input_format: "best_effort" },
});
try {
  await ensureQuoteIntelTable(ch);
  const dir = process.argv[2] ?? ".data/scheduler/raw";
  console.log(JSON.stringify(await backfillQuoteIntel(ch, fileObjectReader(dir))));
} finally {
  await ch.close();
}

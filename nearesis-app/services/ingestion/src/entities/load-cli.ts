/** `pnpm --filter @nearesis/ingestion exec tsx src/entities/load-cli.ts` : migrate nearesis_live, validate and load registry v1. */
import { createLiveCh, migrateLive } from "../backfill/ch.ts";
import { registryV1 } from "./seed-v1.ts";
import { saveEntityRegistry } from "./store.ts";
import { exactMappingsNotObserved, validateRegistry } from "./validate.ts";

const ch = createLiveCh();
try {
  console.log("migrations applied:", await migrateLive(ch));
  const issues = validateRegistry(registryV1);
  if (issues.length) {
    console.error(issues);
    process.exit(1);
  }
  const rs = await ch.query({
    query: "SELECT DISTINCT receiver_account_id AS a FROM contract_interactions",
    format: "JSONEachRow",
  });
  const seen = new Set(((await rs.json()) as Array<{ a: string }>).map((r) => r.a));
  const missing = exactMappingsNotObserved(registryV1, seen).map((m) => m.account);
  console.log("exact mappings never seen as receivers:", missing);
  console.log("loaded:", await saveEntityRegistry(ch, registryV1));
} finally {
  await ch.close();
}

/** `pnpm --filter @nearesis/ingestion exec tsx src/entities/load-cli.ts [v1|v2]` : migrate nearesis_live, validate and load a registry version (default v1; v1 stays intact when v2 is loaded). */
import { createLiveCh, migrateLive } from "../backfill/ch.ts";
import { registryV1 } from "./seed-v1.ts";
import { registryV2 } from "./seed-v2.ts";
import { saveEntityRegistry } from "./store.ts";
import { exactMappingsNotObserved, validateRegistry } from "./validate.ts";

const which = process.argv[2] ?? "v1";
const registry = which === "v2" ? registryV2 : registryV1;
const ch = createLiveCh();
try {
  console.log("migrations applied:", await migrateLive(ch));
  const issues = validateRegistry(registry);
  if (issues.length) {
    console.error(issues);
    process.exit(1);
  }
  const rs = await ch.query({
    query: "SELECT DISTINCT receiver_account_id AS a FROM contract_interactions",
    format: "JSONEachRow",
  });
  const seen = new Set(((await rs.json()) as Array<{ a: string }>).map((r) => r.a));
  const missing = exactMappingsNotObserved(registry, seen).map((m) => m.account);
  console.log("exact mappings never seen as receivers:", missing);
  console.log("loaded:", await saveEntityRegistry(ch, registry));
} finally {
  await ch.close();
}

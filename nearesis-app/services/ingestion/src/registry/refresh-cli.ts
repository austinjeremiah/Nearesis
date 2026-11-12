import { createLiveCh, ensureDatabase, migrateLive } from "../backfill/ch.ts";
import { loadCredentials, openArchive, openLivePg } from "../backfill/env.ts";
import { OneClickQuoteSampler } from "../adapters/oneclick.ts";
import { systemClock } from "../clock.ts";
import { ALLOW_ONECLICK, HttpClient } from "../http/client.ts";
import { SCHEDULER_RAW_DIR } from "../scheduler/config.ts";
import { mappingCounts, rederiveCanonicalAssets, saveLiveAssetRegistry } from "./live-registry.ts";
import { buildRegistryEntries } from "./oneclick-tokens.ts";

/**
 * Refreshes the effective-dated asset registry from the official 1Click token list (one read-only GET /v0/tokens,
 * archived through the raw archive) and re-derives canonical assets of existing swaps. Idempotent.
 * Flags: --no-rederive (registry only), --dry (print the counts the registry would produce, write nothing).
 */
const log = (m: string): void => console.log(`[asset-registry ${new Date().toISOString()}] ${m}`);
const argv = new Set(process.argv.slice(2));

await ensureDatabase();
const ch = createLiveCh();
await migrateLive(ch);
const live = await openLivePg();
try {
  const creds = loadCredentials();
  const sampler = new OneClickQuoteSampler({
    http: new HttpClient({ allow: [ALLOW_ONECLICK], credentials: creds }),
    archive: openArchive(live.db, SCHEDULER_RAW_DIR),
    clock: systemClock,
    sourceEnvironment: "live",
    ...(creds.has("INTENTS_1CLICK_JWT") ? { credentialName: "INTENTS_1CLICK_JWT" } : {}),
  });
  const before = await mappingCounts(ch);
  const fetchedAtUTC = new Date().toISOString();
  const { tokens, objectHash } = await sampler.fetchTokens();
  const entries = buildRegistryEntries(tokens);
  const unknown = entries.filter((e) => e.canonicalAssetId === null);
  log(
    `tokens ${tokens.length}, verified ${entries.length - unknown.length}, unknown ${unknown.length} (${[...new Set(unknown.map((u) => u.unknownReason))].join(",")}), raw ${objectHash}`,
  );
  if (!argv.has("--dry")) {
    await saveLiveAssetRegistry(ch, entries, { rawObjectHash: objectHash, fetchedAtUTC });
    if (!argv.has("--no-rederive")) {
      const r = await rederiveCanonicalAssets(ch, log);
      log(`re-derived ${r.rowsReinserted} rows over ${r.partitions} partitions`);
    }
  }
  const after = await mappingCounts(ch);
  console.log(JSON.stringify({ before, after }, null, 2));
} finally {
  await ch.close();
  await live.db.close();
}

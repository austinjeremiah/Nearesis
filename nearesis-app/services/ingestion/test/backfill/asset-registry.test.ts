import { createClient } from "@clickhouse/client";
import { describe, expect, it } from "vitest";
import type { TokenResponse } from "../../src/adapters/oneclick.ts";
import { createLiveCh, ensureDatabase, migrateLive } from "../../src/backfill/ch.ts";
import { tempName } from "../../src/backfill/env.ts";
import { AssetRegistry } from "../../src/registry/assets.ts";
import {
  loadLiveAssetRegistry,
  mappingCounts,
  rederiveCanonicalAssets,
  saveLiveAssetRegistry,
} from "../../src/registry/live-registry.ts";
import { buildRegistryEntries, entriesToAliases } from "../../src/registry/oneclick-tokens.ts";

const tok = (
  assetId: string,
  symbol: string,
  coingeckoId: string | null,
  blockchain = "eth",
): TokenResponse =>
  ({
    assetId,
    symbol,
    coingeckoId,
    blockchain,
    decimals: 6,
    priceUpdatedAt: "2026-11-12T00:00:00Z",
  }) as TokenResponse;

const TOKENS = [
  tok("nep141:eth-usdc.omft.near", "USDC", "usd-coin"),
  tok("nep141:base-usdc.omft.near", "USDC", "usd-coin", "base"),
  tok("nep245:legacy-bnb", "BNB(DEPRECATED)", "binancecoin", "bsc"),
  tok("nep141:bnb.omdep.near", "BNB", "binancecoin", "bsc"),
  tok("nep141:nocg.near", "NOCG", null, "near"),
  tok("nep141:wbtc-a.near", "WBTC", "wrapped-bitcoin"),
  tok("nep141:wbtc-b.near", "WBTC", "bitcoin"),
];

describe("asset registry from the 1Click token list", () => {
  const entries = buildRegistryEntries(TOKENS);
  const by = (id: string) => entries.find((e) => e.providerAssetId === id)!;

  it("maps verified assets across chains and strips the DEPRECATED marker", () => {
    expect(by("nep141:eth-usdc.omft.near").canonicalAssetId).toBe("USDC");
    expect(by("nep141:base-usdc.omft.near").canonicalAssetId).toBe("USDC");
    expect(by("nep245:legacy-bnb")).toMatchObject({ canonicalAssetId: "BNB", deprecated: true });
    expect(by("nep141:bnb.omdep.near")).toMatchObject({ canonicalAssetId: "BNB", deprecated: false });
  });

  it("keeps unknown assets explicitly unknown with a reason (never guessed)", () => {
    expect(by("nep141:nocg.near")).toMatchObject({
      canonicalAssetId: null,
      verification: "unverified",
      unknownReason: "no_coingecko_identity",
    });
    for (const id of ["nep141:wbtc-a.near", "nep141:wbtc-b.near"])
      expect(by(id)).toMatchObject({
        canonicalAssetId: null,
        verification: "ambiguous",
        unknownReason: "conflicting_identity_for_symbol",
      });
    const reg = new AssetRegistry(entriesToAliases(entries));
    expect(reg.resolve("intents-1click", "nep141:nocg.near", "2026-11-01T00:00:00Z").status).toBe("unknown");
    expect(reg.resolve("intents-1click", "nep141:never-seen.near", "2026-11-01T00:00:00Z").status).toBe(
      "unknown",
    );
  });

  it("honours effective dates and a dated token-ID migration (validFrom inclusive, validTo exclusive)", () => {
    const cut = "2026-11-09T00:00:00.000Z";
    const dated = buildRegistryEntries(TOKENS, { validTo: { "nep245:legacy-bnb": cut } });
    const reg = new AssetRegistry(entriesToAliases(dated));
    const legacy = (t: string) => reg.resolve("intents-1click", "nep245:legacy-bnb", t);
    expect(legacy("2026-11-08T23:59:59Z")).toMatchObject({ status: "found", canonicalAssetId: "BNB" });
    expect(legacy(cut).status).toBe("unknown");
    expect(reg.resolve("intents-1click", "nep141:bnb.omdep.near", cut)).toMatchObject({
      status: "found",
      canonicalAssetId: "BNB",
    });
    // before the registry's first valid_from nothing resolves
    expect(legacy("2026-01-01T00:00:00Z").status).toBe("unknown");
    // both ids denote the same canonical asset, so asset-level series join across the migration
    expect(reg.historicalId("intents-1click", "BNB", "2026-11-10T00:00:00Z")).toBe("nep141:bnb.omdep.near");
    expect(reg.historicalId("intents-1click", "BNB", "2026-11-01T00:00:00Z")).toBeNull(); // both ids live: not unique
  });
});

const SWAP = (key: string, origin: string, dest: string, at: string, version: number) => ({
  swap_key: key,
  deposit_address: "d" + key,
  deposit_memo: null,
  status: "SUCCESS",
  created_at: at,
  created_day: at.slice(0, 10),
  origin_asset: origin,
  destination_asset: dest,
  canonical_origin_asset: null,
  canonical_destination_asset: null,
  amount_in_raw: "1000000",
  amount_out_raw: "999000",
  amount_in: "1000000",
  amount_out: "999000",
  amount_final: 1,
  amount_in_usd_raw: null,
  amount_out_usd_raw: null,
  amount_in_usd: null,
  amount_out_usd: null,
  deposit_type: "ORIGIN_CHAIN",
  recipient_type: "DESTINATION_CHAIN",
  referral: null,
  privacy_era: "public",
  public_swap_tx_hashes: [],
  boundary_tx_hashes: [],
  reconciliation_level: "none",
  source_label: "LIVE",
  raw_object_hash: "h" + key,
  fetched_at: "2026-11-12 00:00:00.000",
  version,
});

describe("re-derivation of existing swaps (ClickHouse, disposable database)", () => {
  it("fills canonical assets by re-insert, is idempotent and leaves unknown legs NULL", async () => {
    const name = tempName();
    await ensureDatabase(name);
    const ch = createLiveCh(name);
    try {
      await migrateLive(ch);
      expect(await loadLiveAssetRegistry(ch)).toBeNull();
      await ch.insert({
        table: "intents_swaps",
        format: "JSONEachRow",
        values: [
          SWAP("a", "nep141:eth-usdc.omft.near", "nep141:bnb.omdep.near", "2026-11-01 10:00:00.000", 1000),
          SWAP("b", "nep141:nocg.near", "nep141:base-usdc.omft.near", "2026-11-02 10:00:00.000", 2000),
          SWAP("c", "nep141:unlisted.near", "nep141:wbtc-a.near", "2026-10-02 10:00:00.000", 3000),
        ],
      });
      expect(await mappingCounts(ch)).toEqual({ total: 3, originMapped: 0, destinationMapped: 0 });
      await saveLiveAssetRegistry(ch, buildRegistryEntries(TOKENS), {
        rawObjectHash: "rawtokens",
        fetchedAtUTC: "2026-11-12T00:00:00.000Z",
      });
      const first = await rederiveCanonicalAssets(ch);
      expect(first.rowsReinserted).toBe(2); // c has no mappable leg
      expect(await mappingCounts(ch)).toEqual({ total: 3, originMapped: 1, destinationMapped: 2 });
      const second = await rederiveCanonicalAssets(ch);
      expect(second.rowsReinserted).toBe(0);
      const rs = await ch.query({
        query:
          "SELECT swap_key, canonical_origin_asset o, canonical_destination_asset d, version FROM intents_swaps FINAL ORDER BY swap_key",
        format: "JSONEachRow",
      });
      expect(await rs.json()).toEqual([
        { swap_key: "a", o: "USDC", d: "BNB", version: 1001 },
        { swap_key: "b", o: null, d: "USDC", version: 2001 },
        { swap_key: "c", o: null, d: null, version: 3000 },
      ]);
      // a stale concurrent insert (old code, same original version, NULL canonical) cannot undo the derivation
      await ch.insert({
        table: "intents_swaps",
        format: "JSONEachRow",
        values: [
          SWAP("a", "nep141:eth-usdc.omft.near", "nep141:bnb.omdep.near", "2026-11-01 10:00:00.000", 1000),
        ],
      });
      const st = await ch.query({
        query: "SELECT canonical_origin_asset o FROM intents_swaps FINAL WHERE swap_key='a'",
        format: "JSONEachRow",
      });
      expect(await st.json()).toEqual([{ o: "USDC" }]);
      // reasons for unknown legs are queryable
      const why = await ch.query({
        query:
          "SELECT swap_key, origin_unknown_reason o, destination_unknown_reason d FROM intents_swap_asset_status ORDER BY swap_key",
        format: "JSONEachRow",
      });
      expect(await why.json()).toEqual([
        { swap_key: "a", o: null, d: null },
        { swap_key: "b", o: "no_coingecko_identity", d: null },
        { swap_key: "c", o: "not_in_registry", d: "conflicting_identity_for_symbol" },
      ]);
    } finally {
      await ch.close();
      const admin = createClient({
        url: process.env.NEARESIS_CH_URL ?? "http://127.0.0.1:58123",
        username: process.env.NEARESIS_CH_USER ?? "nearesis",
        password: process.env.NEARESIS_CH_PASSWORD ?? "nearesis",
        database: "default",
      });
      await admin.command({ query: `DROP DATABASE IF EXISTS ${name}` });
      await admin.close();
    }
  }, 60_000);
});

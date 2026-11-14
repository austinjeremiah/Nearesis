import { observe } from "@nearesis/acceptance";
import { AssetAlias } from "@nearesis/contracts";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { expect, it } from "vitest";
import { z } from "zod";
import { AssetRegistry } from "../../src/registry/assets.ts";
import { replay } from "../../src/replay.ts";

const ID = "fx.registry.asset-aliases";
const LEGACY = "nep245:v2_1.omni.hot.tg:56_11111111111111111111";
const NEW = "nep141:bsc.omft.near";

// D08: Token ID migration -> effective-dated lookup returns correct historical ID
it("resolves legacy and migrated asset IDs by effective date around 2026-11-09", async () => {
  const reg = new AssetRegistry(z.array(AssetAlias).parse(readFixtureJson(ID, "aliases.json")));
  const at = (t: string) => reg.resolve("intents-1click", LEGACY, t);
  const atNew = (t: string) => reg.resolve("intents-1click", NEW, t);
  expect(at("2026-11-08T23:59:59Z")).toMatchObject({ status: "found", canonicalAssetId: "BNB" });
  expect(at("2026-11-09T00:00:00Z").status).toBe("unknown"); // validTo is exclusive
  expect(atNew("2026-11-08T23:59:59Z").status).toBe("unknown");
  expect(atNew("2026-11-09T00:00:00Z")).toMatchObject({ status: "found", canonicalAssetId: "BNB" }); // validFrom inclusive
  expect(reg.historicalId("intents-1click", "BNB", "2026-06-01T00:00:00Z")).toBe(LEGACY);
  expect(reg.historicalId("intents-1click", "BNB", "2026-11-10T00:00:00Z")).toBe(NEW);
  expect(reg.historicalId("intents-1click", "BNB", "2024-01-01T00:00:00Z")).toBeNull();
  const markers = reg.migrationMarkers();
  expect(markers).toEqual([
    { canonicalAssetId: "BNB", at: "2026-11-09T00:00:00.000Z", from: LEGACY, to: NEW },
  ]);

  // unverified aliases never resolve into canonical output
  const out = await replay("fx.snapshot.p02-baseline");
  expect(out.tables.asset_aliases.length).toBe(5);
  const usdc = reg.resolve(
    "intents-1click",
    "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    "2026-11-01T00:00:00Z",
  );
  expect(usdc).toMatchObject({ status: "found", verification: "unverified" });
  expect(
    out.tables.intents_swaps.every(
      (s) => s.canonicalOriginAsset === null || s.canonicalOriginAsset !== "USDC",
    ),
  ).toBe(true);

  observe({
    testId: "D08",
    observed: `legacy HOT BNB id resolves to BNB until 2026-11-08T23:59:59Z, is unknown at 2026-11-09T00:00:00Z; nep141:bsc.omft.near resolves from 2026-11-09T00:00:00Z (validFrom inclusive, validTo exclusive); historicalId(BNB) = legacy before, new after; 1 migration marker`,
    fixtureHash: fixtureHash(ID),
    evidence: { boundary: "[validFrom, validTo)", markers },
  });
});

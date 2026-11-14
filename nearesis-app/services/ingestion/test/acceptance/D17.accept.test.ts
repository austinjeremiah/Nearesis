import { observe } from "@nearesis/acceptance";
import { AssetAlias, ContractRegistryEntry } from "@nearesis/contracts";
import { fixtureHash, readFixtureJson } from "@nearesis/test-fixtures";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { AssetRegistry } from "../../src/registry/assets.ts";
import { ContractRegistry } from "../../src/registry/contracts.ts";
import { loadRegistry, saveRegistry } from "../../src/registry/store.ts";
import { replay } from "../../src/replay.ts";
import { setupEnv, type TestEnv } from "../helpers/env.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setupEnv();
}, 60_000);
afterAll(async () => env.close(), 60_000);

const ID = "fx.registry.contracts-v1";

// D17: Effective-dated contract/partner registry with an unverified state
it("looks up mappings by date, quarantines conflicts, and keeps unverified contracts out of named segments", async () => {
  const entries = z.array(ContractRegistryEntry).parse(readFixtureJson(ID, "contracts.json"));
  const aliases = z.array(AssetAlias).parse(readFixtureJson("fx.registry.asset-aliases", "aliases.json"));
  await saveRegistry(env.tdb.db, new AssetRegistry(aliases), new ContractRegistry(entries)); // load into Postgres
  const { contracts: reg, conflictReports } = await loadRegistry(env.tdb.db);

  const look = (a: string, at: string) => reg.lookup("near", a, at);
  // (a) boundaries: validTo exclusive, validFrom inclusive
  expect(look("v2.ref-finance.near", "2026-11-08T23:59:59Z")).toMatchObject({
    state: "verified",
    entry: { taxonomy: "dex" },
  });
  expect(look("v2.ref-finance.near", "2026-11-09T00:00:00Z")).toMatchObject({
    state: "verified",
    entry: { taxonomy: "dex_aggregator" },
  });
  expect(look("meme-cooking.near", "2025-12-31T23:59:59Z").state).toBe("uncategorized");
  expect(look("meme-cooking.near", "2026-01-01T00:00:00Z")).toMatchObject({
    state: "verified",
    entry: { project: "meme.cooking" },
  });
  expect(() => look("hot.tg", "")).toThrow(); // undated lookup refused
  // (b) conflict quarantined, lookups ambiguous, report stored
  const amb = look("shared-dao.near", "2026-07-01T00:00:00Z");
  expect(amb.state).toBe("ambiguous");
  const quarantined = reg.rows.filter((r) => r.rowState === "quarantined");
  expect(quarantined).toHaveLength(2);
  expect(new Set(quarantined.map((r) => r.conflictGroup)).size).toBe(1);
  expect(reg.conflicts).toHaveLength(1);
  expect(conflictReports).toHaveLength(1);
  const dbq = await env.tdb.db.query<{ n: string }>(
    "SELECT count(*) n FROM ingestion.contract_registry WHERE row_state='quarantined'",
  );
  expect(Number(dbq.rows[0]?.n)).toBe(2);
  // (c) unverified contract never lands in the named segment
  expect(reg.assign("near", "outlayer.unresolved.near", "2026-10-01T00:00:00Z")).toEqual({
    project: null,
    taxonomy: "unverified",
    segmentState: "unverified",
  });
  expect(reg.assign("near", "shared-dao.near", "2026-07-01T00:00:00Z")).toMatchObject({
    project: null,
    segmentState: "ambiguous",
  });
  expect(reg.assign("near", "unknown.near", "2026-10-01T00:00:00Z")).toMatchObject({
    project: null,
    taxonomy: "uncategorized",
  });
  const out = await replay("fx.snapshot.p02-baseline");
  const interactions = out.tables.contract_interactions;
  const outlayer = interactions.filter((r) => r.receiverAccountId === "outlayer.unresolved.near");
  expect(outlayer.length).toBe(2);
  expect(outlayer.every((r) => r.project === null && r.segmentState === "unverified")).toBe(true);
  expect(interactions.filter((r) => r.project === "OutLayer")).toHaveLength(0);
  // (d) aggregate for the unverified project is a structured SEGMENT_UNVERIFIED
  const recs = interactions.map((r) => ({
    chain: "near",
    accountId: r.receiverAccountId,
    at: `${r.blockDate}T00:00:00Z`,
    interactions: r.interactions,
  }));
  const agg = reg.segmentAggregate("OutLayer", recs);
  expect(agg).toMatchObject({ ok: false, code: "SEGMENT_UNVERIFIED", project: "OutLayer", retryable: false });
  const okAgg = reg.segmentAggregate("meme.cooking", recs);
  expect(okAgg).toMatchObject({ ok: true, interactions: "241", included: 2 });
  // (e) every mapping carries evidence or is explicitly unverified; verified-without-evidence is demoted
  expect(reg.rows.every((r) => r.evidenceUrl !== null || r.ownershipVerification === "unverified")).toBe(
    true,
  );
  const demo = new ContractRegistry([{ ...entries[0]!, accountId: "noevidence.near", evidenceUrl: null }]);
  expect(demo.rows[0]?.ownershipVerification).toBe("unverified");
  expect(demo.demoted).toHaveLength(1);

  observe({
    testId: "D17",
    observed: `boundary lookups exact (validTo exclusive, validFrom inclusive); 2 conflicting shared-dao.near rows quarantined (1 conflict report, lookup=ambiguous); OutLayer receipts -> unverified/null project (0 in named segment); OutLayer aggregate -> SEGMENT_UNVERIFIED; all ${reg.rows.length} rows have evidence or unverified state`,
    fixtureHash: fixtureHash(ID),
    evidence: {
      conflictReports,
      aggregateUnverified: agg,
      aggregateVerified: okAgg,
      quarantinedRows: quarantined.length,
      outlayerRows: outlayer.map((r) => ({
        account: r.receiverAccountId,
        segmentState: r.segmentState,
        project: r.project,
      })),
      demotedWithoutEvidence: demo.demoted,
    },
  });
}, 60_000);

import { AssetAlias, ContractRegistryEntry } from "@nearesis/contracts";
import type { Db } from "../db.ts";
import { AssetRegistry } from "./assets.ts";
import { ContractRegistry } from "./contracts.ts";

/** Replace the persisted registry (schema `ingestion`) with the given entries. Conflicting rows are stored quarantined. */
export async function saveRegistry(
  db: Db,
  assets: AssetRegistry,
  contracts: ContractRegistry,
): Promise<void> {
  await db.tx(async (c) => {
    await c.query("DELETE FROM ingestion.asset_aliases");
    await c.query("DELETE FROM ingestion.contract_registry");
    await c.query("DELETE FROM ingestion.registry_conflicts");
    for (const a of assets.aliases) {
      AssetAlias.parse(a);
      await c.query("INSERT INTO ingestion.asset_aliases VALUES ($1,$2,$3,$4,$5,$6,$7)", [
        a.canonicalAssetId,
        a.providerAssetId,
        a.providerId,
        a.validFrom,
        a.validTo,
        a.evidenceUrl,
        a.verification,
      ]);
    }
    for (const r of contracts.rows) {
      await c.query(
        `INSERT INTO ingestion.contract_registry(chain, account_id, project, taxonomy, valid_from, valid_to, ownership_verification, evidence_url, ambiguity_score, row_state, conflict_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          r.chain,
          r.accountId,
          r.project,
          r.taxonomy,
          r.validFrom,
          r.validTo,
          r.ownershipVerification,
          r.evidenceUrl,
          r.ambiguityScore,
          r.rowState,
          r.conflictGroup,
        ],
      );
    }
    for (const k of contracts.conflicts) {
      await c.query(
        "INSERT INTO ingestion.registry_conflicts(conflict_group, chain, account_id, report) VALUES ($1,$2,$3,$4)",
        [k.conflictGroup, k.chain, k.accountId, JSON.stringify(k)],
      );
    }
  });
}

export async function loadRegistry(
  db: Db,
): Promise<{ assets: AssetRegistry; contracts: ContractRegistry; conflictReports: unknown[] }> {
  const a = await db.query<{
    canonical_asset_id: string;
    provider_asset_id: string;
    provider_id: string;
    valid_from: Date;
    valid_to: Date | null;
    evidence_url: string | null;
    verification: string;
  }>("SELECT * FROM ingestion.asset_aliases ORDER BY provider_id, provider_asset_id, valid_from");
  const c = await db.query<{
    chain: string;
    account_id: string;
    project: string;
    taxonomy: string;
    valid_from: Date;
    valid_to: Date | null;
    ownership_verification: string;
    evidence_url: string | null;
    ambiguity_score: number;
  }>("SELECT * FROM ingestion.contract_registry ORDER BY id");
  const k = await db.query<{ report: unknown }>(
    "SELECT report FROM ingestion.registry_conflicts ORDER BY conflict_group",
  );
  return {
    assets: new AssetRegistry(
      a.rows.map((r) =>
        AssetAlias.parse({
          canonicalAssetId: r.canonical_asset_id,
          providerAssetId: r.provider_asset_id,
          providerId: r.provider_id,
          validFrom: r.valid_from.toISOString(),
          validTo: r.valid_to?.toISOString() ?? null,
          evidenceUrl: r.evidence_url,
          verification: r.verification,
        }),
      ),
    ),
    // Reload from the raw entries (conflict detection is deterministic, so quarantine state is reproduced).
    contracts: new ContractRegistry(
      c.rows.map((r) =>
        ContractRegistryEntry.parse({
          chain: r.chain,
          accountId: r.account_id,
          project: r.project,
          taxonomy: r.taxonomy,
          validFrom: r.valid_from.toISOString(),
          validTo: r.valid_to?.toISOString() ?? null,
          ownershipVerification: r.ownership_verification,
          evidenceUrl: r.evidence_url,
          ambiguityScore: r.ambiguity_score,
        }),
      ),
    ),
    conflictReports: k.rows.map((x) => x.report),
  };
}

export const Registry = { assets: AssetRegistry, contracts: ContractRegistry };

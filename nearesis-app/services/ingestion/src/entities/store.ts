import type { ClickHouseClient } from "@clickhouse/client";
import { assertValidRegistry } from "./validate.ts";
import { mappingId, relationId, type Registry } from "./types.ts";

const ts = (iso: string | null): string | null =>
  iso === null ? null : new Date(iso).toISOString().replace("T", " ").replace("Z", "");

/** Validates, then inserts one registry version. Re-running with the same version is idempotent (same version number). */
export async function saveEntityRegistry(
  ch: ClickHouseClient,
  reg: Registry,
): Promise<{ entities: number; mappings: number; relations: number }> {
  assertValidRegistry(reg);
  const version = Date.parse(reg.publishedAt);
  const rv = reg.registryVersion;
  const base = { source_label: "LIVE", version };
  const entities = reg.entities.map((e) => ({
    entity_id: e.entityId,
    entity_type: e.entityType,
    name: e.name,
    category_id: e.categoryId,
    parent_entity_id: e.parentEntityId,
    description: e.description,
    registry_version: rv,
    ...base,
  }));
  const mappings = reg.mappings.map((m) => ({
    mapping_id: mappingId(rv, m),
    entity_id: m.entityId,
    network: m.network,
    match_type: m.matchType,
    account: m.account,
    role: m.role,
    effective_from: ts(m.effectiveFrom),
    effective_to: ts(m.effectiveTo),
    registry_version: rv,
    methodology: m.methodology,
    verification: m.verification,
    confidence: m.confidence,
    evidence_kind: m.evidenceKind,
    evidence_url: m.evidenceUrl,
    evidence_note: m.evidenceNote,
    limitations: m.limitations,
    precedence: m.precedence,
    ...base,
  }));
  const relations = reg.relations.map((r) => ({
    relation_id: relationId(rv, r),
    from_entity_id: r.fromEntityId,
    to_entity_id: r.toEntityId,
    relation: r.relation,
    effective_from: ts(r.effectiveFrom),
    effective_to: ts(r.effectiveTo),
    verification: r.verification,
    evidence_url: r.evidenceUrl,
    note: r.note,
    registry_version: rv,
    ...base,
  }));
  await ch.insert({ table: "entities", values: entities, format: "JSONEachRow" });
  await ch.insert({ table: "entity_mappings", values: mappings, format: "JSONEachRow" });
  await ch.insert({ table: "entity_relations", values: relations, format: "JSONEachRow" });
  return { entities: entities.length, mappings: mappings.length, relations: relations.length };
}

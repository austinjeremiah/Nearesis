import { ENTITY_TYPES, Entity, Mapping, Relation, mappingId, type Registry } from "./types.ts";

export interface ValidationIssue {
  code: string;
  subject: string;
  message: string;
}

const end = (iso: string | null): number => (iso === null ? Infinity : Date.parse(iso));
const overlaps = (a: Mapping, b: Mapping): boolean =>
  Date.parse(a.effectiveFrom) < end(b.effectiveTo) && Date.parse(b.effectiveFrom) < end(a.effectiveTo);

/**
 * Registry rules (ch.07 / D17):
 *  - every mapping has evidence (URL; plus a kind other than "none" unless it is `unverified`),
 *  - verified requires a primary evidence kind (docs, repo, explorer label or on-chain), not third-party,
 *  - suffix rules begin with "." and are never "verified" by name alone,
 *  - effective_to > effective_from,
 *  - overlapping mappings of one (network, matchType, account) to DIFFERENT entities need different precedence,
 *  - overlapping duplicates for the same entity are redundant and rejected,
 *  - references (entity, category, parent, relation) resolve.
 * Returns every issue (it never stops at the first) so the caller can show the full list.
 */
export function validateRegistry(reg: Registry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, subject: string, message: string) => issues.push({ code, subject, message });

  const ids = new Set<string>();
  for (const e of reg.entities) {
    const p = Entity.safeParse(e);
    if (!p.success) add("ENTITY_SCHEMA", e.entityId, p.error.message.slice(0, 200));
    if (ids.has(e.entityId)) add("ENTITY_DUPLICATE", e.entityId, "duplicate entity id");
    ids.add(e.entityId);
  }
  const byId = new Map(reg.entities.map((e) => [e.entityId, e]));
  for (const e of reg.entities) {
    if (e.categoryId !== null) {
      const c = byId.get(e.categoryId);
      if (!c) add("CATEGORY_UNKNOWN", e.entityId, `category ${e.categoryId} not in registry`);
      else if (c.entityType !== "category")
        add("CATEGORY_NOT_CATEGORY", e.entityId, `${e.categoryId} is not a category entity`);
    }
    if (e.parentEntityId !== null && !byId.has(e.parentEntityId))
      add("PARENT_UNKNOWN", e.entityId, `parent ${e.parentEntityId} not in registry`);
    if (!ENTITY_TYPES.includes(e.entityType)) add("ENTITY_TYPE", e.entityId, "unknown type");
  }

  reg.mappings.forEach((m, i) => {
    const subject = `${m.entityId}:${m.account}#${i}`;
    const p = Mapping.safeParse(m);
    if (!p.success) {
      add(
        "MAPPING_SCHEMA",
        subject,
        p.error.issues
          .map((x) => `${x.path.join(".")}: ${x.message}`)
          .join("; ")
          .slice(0, 300),
      );
      return;
    }
    if (!byId.has(m.entityId)) add("MAPPING_ENTITY_UNKNOWN", subject, "entity not in registry");
    else if (byId.get(m.entityId)!.entityType === "category")
      add("MAPPING_TO_CATEGORY", subject, "accounts map to concrete entities; categories are roll-ups");
    if (m.matchType === "suffix" && !m.account.startsWith("."))
      add("SUFFIX_FORMAT", subject, "suffix mappings must start with '.'");
    if (m.matchType === "exact" && m.account.startsWith("."))
      add("EXACT_FORMAT", subject, "exact mappings must be a full account id");
    if (m.effectiveTo !== null && Date.parse(m.effectiveTo) <= Date.parse(m.effectiveFrom))
      add("EFFECTIVE_RANGE", subject, "effective_to must be after effective_from");
    if (m.verification !== "unverified" && m.evidenceKind === "none")
      add("EVIDENCE_REQUIRED", subject, "verified/inferred mappings need an evidence kind");
    if (m.verification === "verified" && m.evidenceKind === "third_party")
      add(
        "VERIFIED_NEEDS_PRIMARY",
        subject,
        "verified requires official docs, repo, explorer label or on-chain evidence",
      );
    if (m.verification === "verified" && m.matchType === "suffix")
      add(
        "SUFFIX_NOT_VERIFIED",
        subject,
        "a suffix rule generalises beyond the evidenced account: use inferred",
      );
    if (m.verification === "verified" && m.confidence === "low")
      add("VERIFIED_LOW_CONFIDENCE", subject, "verified mappings cannot be low confidence");
  });

  const valid = reg.mappings.filter((m) => Mapping.safeParse(m).success);
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const a = valid[i]!;
      const b = valid[j]!;
      if (a.network !== b.network || a.matchType !== b.matchType || a.account !== b.account) continue;
      if (!overlaps(a, b)) continue;
      const subject = `${a.account}`;
      if (a.entityId === b.entityId)
        add("MAPPING_DUPLICATE_OVERLAP", subject, `overlapping duplicate rows for ${a.entityId}`);
      else if (a.precedence === b.precedence)
        add(
          "MAPPING_AMBIGUOUS_OVERLAP",
          subject,
          `${a.entityId} and ${b.entityId} overlap with equal precedence ${a.precedence}`,
        );
    }

  reg.relations.forEach((r, i) => {
    const p = Relation.safeParse(r);
    const subject = `${r.fromEntityId}-${r.relation}-${r.toEntityId}#${i}`;
    if (!p.success) return void add("RELATION_SCHEMA", subject, p.error.message.slice(0, 200));
    if (!byId.has(r.fromEntityId) || !byId.has(r.toEntityId))
      add("RELATION_ENTITY_UNKNOWN", subject, "relation endpoint not in registry");
    if (r.fromEntityId === r.toEntityId) add("RELATION_SELF", subject, "self relation");
  });

  // Stable ids must be unique.
  const seen = new Set<string>();
  for (const m of reg.mappings) {
    const id = mappingId(reg.registryVersion, m);
    if (seen.has(id)) add("MAPPING_ID_COLLISION", id, "two rows share a mapping id");
    seen.add(id);
  }
  return issues;
}

export function assertValidRegistry(reg: Registry): void {
  const issues = validateRegistry(reg);
  if (issues.length)
    throw new Error(
      `entity registry invalid:\n${issues.map((i) => `${i.code} ${i.subject}: ${i.message}`).join("\n")}`,
    );
}

/** Accounts of exact mappings that were never seen as receivers: reported, not silently dropped. */
export function exactMappingsNotObserved(reg: Registry, seenReceivers: Set<string>): Mapping[] {
  return reg.mappings.filter((m) => m.matchType === "exact" && !seenReceivers.has(m.account));
}

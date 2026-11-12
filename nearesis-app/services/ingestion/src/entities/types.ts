import { z } from "zod";

export const ENTITY_TYPES = [
  "application",
  "protocol",
  "dao",
  "bridge",
  "token_contract",
  "intents_contract",
  "infrastructure",
  "category",
] as const;
export const EntityType = z.enum(ENTITY_TYPES);

const Iso = z.iso.datetime({ offset: false });

export const Entity = z.strictObject({
  entityId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/),
  entityType: EntityType,
  name: z.string().min(1).max(200),
  /** entity_id of a `category` entity (applications, protocols, bridges, ... roll up into categories). */
  categoryId: z.string().nullable(),
  parentEntityId: z.string().nullable(),
  description: z.string().max(1000),
});
export type Entity = z.infer<typeof Entity>;

export const Verification = z.enum(["verified", "inferred", "unverified"]);
export const Confidence = z.enum(["high", "medium", "low"]);
export const EvidenceKind = z.enum([
  "official_docs",
  "official_repo",
  "explorer_label",
  "onchain",
  "third_party",
  "none",
]);

export const Mapping = z.strictObject({
  entityId: z.string(),
  network: z.literal("near"),
  matchType: z.enum(["exact", "suffix"]),
  /** exact: the full account id. suffix: starts with "." (every sub-account of that parent). */
  account: z.string().min(2).max(128),
  role: z.enum([
    "contract",
    "token",
    "factory",
    "verifier",
    "bridge",
    "governance",
    "instance",
    "infrastructure",
  ]),
  effectiveFrom: Iso,
  effectiveTo: Iso.nullable(),
  methodology: z.string().min(10).max(500),
  verification: Verification,
  confidence: Confidence,
  evidenceKind: EvidenceKind,
  evidenceUrl: z.url(),
  evidenceNote: z.string().max(1500),
  limitations: z.string().min(5).max(1000),
  /** Lower wins among equally specific mappings that overlap in time. */
  precedence: z.number().int().min(0).max(1000),
});
export type Mapping = z.infer<typeof Mapping>;

export const Relation = z.strictObject({
  fromEntityId: z.string(),
  toEntityId: z.string(),
  relation: z.enum(["alias_of", "migrated_to", "uses_infrastructure", "part_of"]),
  effectiveFrom: Iso.nullable(),
  effectiveTo: Iso.nullable(),
  verification: Verification,
  evidenceUrl: z.url(),
  note: z.string().max(1000),
});
export type Relation = z.infer<typeof Relation>;

export interface Registry {
  registryVersion: string;
  publishedAt: string;
  entities: Entity[];
  mappings: Mapping[];
  relations: Relation[];
}

export const mappingId = (
  registryVersion: string,
  m: Pick<Mapping, "entityId" | "matchType" | "account" | "effectiveFrom">,
): string => `${registryVersion}:${m.entityId}:${m.matchType}:${m.account}:${m.effectiveFrom.slice(0, 10)}`;
export const relationId = (
  registryVersion: string,
  r: Pick<Relation, "fromEntityId" | "toEntityId" | "relation">,
): string => `${registryVersion}:${r.fromEntityId}:${r.relation}:${r.toEntityId}`;

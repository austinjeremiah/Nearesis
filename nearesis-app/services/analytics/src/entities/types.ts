/** Read-side registry shapes (the registry is written by services/ingestion/src/entities; this module only reads it). */
export type EntityType =
  | "application"
  | "protocol"
  | "dao"
  | "bridge"
  | "token_contract"
  | "intents_contract"
  | "infrastructure"
  | "category";
export type Verification = "verified" | "inferred" | "unverified";

export interface EntityRow {
  entityId: string;
  entityType: EntityType;
  name: string;
  categoryId: string | null;
  parentEntityId: string | null;
  description: string;
  registryVersion: string;
}
export interface MappingRow {
  mappingId: string;
  entityId: string;
  network: string;
  matchType: "exact" | "suffix";
  account: string;
  role: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  registryVersion: string;
  methodology: string;
  verification: Verification;
  confidence: "high" | "medium" | "low";
  evidenceKind: string;
  evidenceUrl: string;
  evidenceNote: string;
  limitations: string;
  precedence: number;
}
export interface RelationRow {
  relationId: string;
  fromEntityId: string;
  toEntityId: string;
  relation: "alias_of" | "migrated_to" | "uses_infrastructure" | "part_of";
  effectiveFrom: string | null;
  effectiveTo: string | null;
  verification: Verification;
  evidenceUrl: string;
  note: string;
  registryVersion: string;
}
export interface RegistrySnapshot {
  registryVersion: string;
  entities: EntityRow[];
  mappings: MappingRow[];
  relations: RelationRow[];
}

export interface ReceiverDay {
  date: string; // YYYY-MM-DD
  receiver: string;
  interactions: number;
}
export interface RemainderDay {
  date: string;
  interactions: number;
}

/** The data the metrics are computed from (contract_interactions + below-threshold remainder), with the days present. */
export interface ActivityInput {
  receivers: ReceiverDay[];
  remainder: RemainderDay[];
}

export interface EntityDataSource {
  registry(): Promise<RegistrySnapshot>;
  /** Receiver-day and remainder rows for the inclusive date range [from, to]. */
  activity(from: string, to: string): Promise<ActivityInput>;
  /** Latest block_date present in contract_interactions (null when empty). */
  latestDate(): Promise<string | null>;
}

-- Source-backed, time-versioned NEAR ecosystem entity registry (final_master_prompt s5, Build Bible ch.07/ch.14).
-- Reference data, global (no tenant rows). Every mapping carries evidence, network, effective interval, registry
-- version, methodology, verification/confidence and attribution limitations. Unknown stays unclassified: there is
-- deliberately no "guessed" verification state. Rows are immutable per (registry_version, id); a later registry_version
-- supersedes an earlier one through ReplacingMergeTree(version).
CREATE TABLE IF NOT EXISTS entities
(
  entity_id String,
  entity_type LowCardinality(String),      -- application|protocol|dao|bridge|token_contract|intents_contract|infrastructure|category
  name String,
  category_id Nullable(String),            -- entity_id of a category entity
  parent_entity_id Nullable(String),
  description String,
  registry_version String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (entity_id);

-- One application can own many mappings (many contracts); one contract maps to one entity at a time per precedence rules.
CREATE TABLE IF NOT EXISTS entity_mappings
(
  mapping_id String,
  entity_id String,
  network LowCardinality(String),
  match_type LowCardinality(String),       -- exact | suffix (suffix includes the leading dot, e.g. .meme-cooking.near)
  account String,
  role LowCardinality(String),             -- contract|token|factory|verifier|bridge|governance|instance|infrastructure
  effective_from DateTime64(3, 'UTC'),
  effective_to Nullable(DateTime64(3, 'UTC')),   -- exclusive; NULL = open ended
  registry_version String,
  methodology String,
  verification LowCardinality(String),     -- verified | inferred | unverified (unverified is never counted in a named segment)
  confidence LowCardinality(String),       -- high | medium | low
  evidence_kind LowCardinality(String),    -- official_docs|official_repo|explorer_label|onchain|third_party|none
  evidence_url String,
  evidence_note String,
  limitations String,
  precedence UInt16,                       -- lower wins among same specificity; equal precedence + different entity = ambiguous
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (network, account, mapping_id);

-- alias_of | migrated_to | uses_infrastructure | part_of. Shared infrastructure is a relation, never a second attribution.
CREATE TABLE IF NOT EXISTS entity_relations
(
  relation_id String,
  from_entity_id String,
  to_entity_id String,
  relation LowCardinality(String),
  effective_from Nullable(DateTime64(3, 'UTC')),
  effective_to Nullable(DateTime64(3, 'UTC')),
  verification LowCardinality(String),
  evidence_url String,
  note String,
  registry_version String,
  source_label LowCardinality(String) DEFAULT 'LIVE',
  version UInt64
)
ENGINE = ReplacingMergeTree(version)
ORDER BY (relation_id);

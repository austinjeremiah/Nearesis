CREATE SCHEMA IF NOT EXISTS ingestion;

CREATE TABLE ingestion.raw_observations (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL,
  request_fingerprint text NOT NULL,
  payload_object_hash text NOT NULL,
  fetched_at timestamptz NOT NULL,
  envelope jsonb NOT NULL,
  request jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX raw_observations_provider_idx ON ingestion.raw_observations (provider_id, fetched_at);
CREATE INDEX raw_observations_hash_idx ON ingestion.raw_observations (payload_object_hash);

CREATE TABLE ingestion.cursor_state (
  provider_id text NOT NULL,
  stream_key text NOT NULL,
  cursor jsonb,
  page_hash text,
  retrieved_at timestamptz,
  schema_version text,
  latest_event_time timestamptz,
  pages_committed integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, stream_key)
);

CREATE TABLE ingestion.explorer_swaps (
  swap_key text PRIMARY KEY,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  amount_in text NOT NULL,
  amount_out text NOT NULL,
  raw_object_hash text NOT NULL,
  version_ms bigint NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX explorer_swaps_created_idx ON ingestion.explorer_swaps (created_at);

CREATE TABLE ingestion.explorer_swap_versions (
  swap_key text NOT NULL,
  raw_object_hash text NOT NULL,
  status text NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (swap_key, raw_object_hash)
);

CREATE TABLE ingestion.quarantine (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL,
  kind text NOT NULL,
  reason_code text NOT NULL,
  raw_object_hash text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion.trace_events (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  provider_id text NOT NULL,
  kind text NOT NULL,
  subject text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE ingestion.source_health (
  provider_id text NOT NULL,
  stream_key text NOT NULL,
  health text NOT NULL,
  watermark_state text NOT NULL,
  circuit jsonb NOT NULL DEFAULT '{}'::jsonb,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, stream_key)
);

CREATE TABLE ingestion.source_coverage (
  provider_id text NOT NULL,
  dataset text NOT NULL,
  day date NOT NULL,
  state text NOT NULL CHECK (state IN ('complete', 'partial', 'unavailable')),
  reason text,
  observed_rows integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, dataset, day)
);

CREATE TABLE ingestion.quality_gaps (
  id bigserial PRIMARY KEY,
  provider_id text NOT NULL,
  dataset text NOT NULL,
  from_utc timestamptz NOT NULL,
  to_utc timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('unavailable', 'partial')),
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingestion.asset_aliases (
  canonical_asset_id text NOT NULL,
  provider_asset_id text NOT NULL,
  provider_id text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  evidence_url text,
  verification text NOT NULL,
  PRIMARY KEY (provider_id, provider_asset_id, valid_from)
);

CREATE TABLE ingestion.contract_registry (
  id bigserial PRIMARY KEY,
  chain text NOT NULL,
  account_id text NOT NULL,
  project text NOT NULL,
  taxonomy text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  ownership_verification text NOT NULL,
  evidence_url text,
  ambiguity_score double precision NOT NULL,
  row_state text NOT NULL DEFAULT 'active',
  conflict_group text
);
CREATE INDEX contract_registry_acct_idx ON ingestion.contract_registry (chain, account_id);

CREATE TABLE ingestion.registry_conflicts (
  conflict_group text PRIMARY KEY,
  chain text NOT NULL,
  account_id text NOT NULL,
  report jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

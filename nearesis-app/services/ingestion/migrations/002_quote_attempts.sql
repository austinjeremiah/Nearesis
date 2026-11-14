CREATE TABLE ingestion.quote_attempts (
  route_id text NOT NULL,
  amount_base_units text NOT NULL,
  privacy_mode text NOT NULL CHECK (privacy_mode IN ('public', 'basic', 'advanced')),
  scheduled_bucket_utc timestamptz NOT NULL,
  attempt_no integer NOT NULL,
  slot text NOT NULL CHECK (slot IN ('observed', 'unavailable')),
  class text CHECK (class IN ('OK', 'NO_QUOTE', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_OUTPUT')),
  amount_out_base_units text,
  fetched_at timestamptz,
  raw_object_hash text,
  dry boolean NOT NULL DEFAULT true CHECK (dry),
  reason text,
  PRIMARY KEY (route_id, amount_base_units, privacy_mode, scheduled_bucket_utc, attempt_no),
  CHECK ((slot = 'observed' AND class IS NOT NULL) OR (slot = 'unavailable' AND class IS NULL))
);

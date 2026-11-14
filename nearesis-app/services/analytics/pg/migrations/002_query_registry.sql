-- Content-addressed, insert-only registry of executed semantic queries (canvas provenance, C14).
CREATE TABLE IF NOT EXISTS analytics_meta.query_registry (
  query_hash          text        PRIMARY KEY,
  ast                 jsonb       NOT NULL,
  semantic_version    text        NOT NULL,
  semantic_model_hash text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION analytics_meta.query_registry_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'analytics_meta.query_registry is insert-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS query_registry_no_change ON analytics_meta.query_registry;
CREATE TRIGGER query_registry_no_change BEFORE UPDATE OR DELETE ON analytics_meta.query_registry
  FOR EACH ROW EXECUTE FUNCTION analytics_meta.query_registry_immutable();

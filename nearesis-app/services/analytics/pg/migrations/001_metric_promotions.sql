CREATE SCHEMA IF NOT EXISTS analytics_meta;

-- Registry change / promotion ledger (S12). A row is inactive until status = 'approved'.
CREATE TABLE IF NOT EXISTS analytics_meta.metric_promotions (
  id            bigserial PRIMARY KEY,
  metric_id     text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('definition_change', 'promotion')),
  status        text        NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected')),
  from_version  text        NOT NULL,
  to_version    text,
  from_hash     text        NOT NULL,
  to_hash       text,
  diff_hash     text,
  proposal      jsonb       NOT NULL,
  diff_report   jsonb,
  proposed_by   text        NOT NULL,
  approver      text,
  reason_code   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS metric_promotions_metric_idx ON analytics_meta.metric_promotions (metric_id, id);

SET LOCAL search_path = runtime;

-- Cost control (ch.13 "Cost model", PERF12): a per-workspace metering ledger over nine dimensions, the spend policy
-- (cap, per-dimension limits, paid-operation permissions, alert frequency cap) and the block / alert records.
-- Prices are configuration (`rates`), never constants in code (ch.13: no fixed price claims).

CREATE TABLE IF NOT EXISTS cost_policies (
  tenant_id           uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  cap_usd             numeric NOT NULL CHECK (cap_usd >= 0),
  period_start        timestamptz NOT NULL,
  period_days         int NOT NULL DEFAULT 30 CHECK (period_days BETWEEN 1 AND 366),
  -- {dimension: maxQuantity} within the period; absent = unlimited for that dimension
  dimension_limits    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- {dimension: usdPerUnit}
  rates               jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_ops_permitted  text[] NOT NULL DEFAULT '{}',
  -- the single declared in-flight allowance: the most the ledger may exceed cap_usd by (actual vs reserved estimate)
  inflight_allowance_usd numeric NOT NULL DEFAULT 0 CHECK (inflight_allowance_usd >= 0),
  alert_thresholds    jsonb NOT NULL DEFAULT '[0.5,0.8,0.95]'::jsonb,
  alert_max_per_window int NOT NULL DEFAULT 3 CHECK (alert_max_per_window >= 0),
  alert_window_seconds int NOT NULL DEFAULT 3600 CHECK (alert_window_seconds > 0),
  alert_cooldown_seconds int NOT NULL DEFAULT 300 CHECK (alert_cooldown_seconds >= 0),
  hard_stopped_at     timestamptz,
  hard_stop_reason    text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  run_id        uuid,
  entry_key     text NOT NULL UNIQUE,
  dimension     text NOT NULL CHECK (dimension IN (
    'bigquery_bytes_billed','external_requests','ai_tokens','outlayer_compute','clickhouse_cpu',
    'clickhouse_io','object_storage_gb_month','network_egress_bytes','workflow_operations')),
  quantity      numeric NOT NULL CHECK (quantity >= 0),
  usd           numeric NOT NULL CHECK (usd >= 0),
  state         text NOT NULL CHECK (state IN ('reserved','settled','released')),
  paid_op       text,
  overrun_usd   numeric NOT NULL DEFAULT 0,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz
);
CREATE INDEX IF NOT EXISTS cost_ledger_ws_idx ON cost_ledger (tenant_id, workspace_id, created_at);

CREATE TABLE IF NOT EXISTS cost_blocks (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  entry_key     text,
  dimension     text NOT NULL,
  reason        text NOT NULL CHECK (reason IN ('CAP_REACHED','DIMENSION_LIMIT','PAID_OP_NOT_PERMITTED','HARD_STOPPED')),
  requested_quantity numeric NOT NULL,
  requested_usd numeric NOT NULL,
  ledger_usd    numeric NOT NULL,
  cap_usd       numeric,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cost_blocks_ws_idx ON cost_blocks (tenant_id, workspace_id, created_at);

-- Operational alerts (cost caps, SLO burn). tenant_id NULL = platform-level (SLO) alerts. Every trigger is recorded;
-- `status='suppressed'` rows are the de-duplicated / cooled-down / over-cap ones (ch.13 alert noise rules).
CREATE TABLE IF NOT EXISTS ops_alerts (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid,
  workspace_id  uuid,
  alert_key     text NOT NULL,
  kind          text NOT NULL,
  severity      text NOT NULL DEFAULT 'warning',
  status        text NOT NULL CHECK (status IN ('sent','suppressed')),
  suppressed_reason text CHECK (suppressed_reason IN ('duplicate','cooldown','window_cap')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ops_alerts_key_idx ON ops_alerts (alert_key, created_at);

-- SLO events in one-minute buckets (good/total counts only, platform level, no tenant data).
CREATE TABLE IF NOT EXISTS slo_buckets (
  slo_id        text NOT NULL,
  bucket_start  timestamptz NOT NULL,
  good          bigint NOT NULL DEFAULT 0,
  total         bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (slo_id, bucket_start)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cost_policies','cost_ledger','cost_blocks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nearesis_app', t);
  END LOOP;
END $$;

ALTER TABLE ops_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ops_alerts;
CREATE POLICY tenant_isolation ON ops_alerts
  USING (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (tenant_id IS NULL OR tenant_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON ops_alerts, slo_buckets TO nearesis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA runtime TO nearesis_app;

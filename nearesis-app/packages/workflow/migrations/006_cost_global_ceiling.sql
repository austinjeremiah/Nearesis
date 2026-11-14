SET LOCAL search_path = runtime;

-- Global model-spend ceiling and unknown-price accounting (final_master_prompt s18).
--
-- 1. An unknown price is never recorded as 0: `usd` becomes nullable and `price_unknown` says why. Existing rows keep
--    their value (historic rows were metered before this rule and cannot be told apart from a priced 0).
-- 2. `estimated_usd` keeps the reservation estimate after settlement so a reconciliation can compare estimate and actual.
-- 3. ONE global USD 5 model-spend ceiling for the whole system (not per workspace, not per day). Model spend is mirrored
--    into `cost_global_model_spend`, which has NO tenant column and no RLS, so the ceiling sees every tenant's spend
--    while holding only amounts and ledger keys (the per-tenant ledger still holds who spent what, behind RLS).

ALTER TABLE cost_ledger ALTER COLUMN usd DROP NOT NULL;
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS price_unknown boolean NOT NULL DEFAULT false;
ALTER TABLE cost_ledger ADD COLUMN IF NOT EXISTS estimated_usd numeric;
ALTER TABLE cost_ledger DROP CONSTRAINT IF EXISTS cost_ledger_price_known;
ALTER TABLE cost_ledger ADD CONSTRAINT cost_ledger_price_known CHECK (price_unknown OR usd IS NOT NULL);

-- Owner-set: dimensions whose spend is refused (PRICE_UNKNOWN) while no price is configured. Model spend (ai_tokens) always
-- needs a price because the global ceiling applies to every workspace. Default: none beyond that, so existing metering
-- continues and records `price_unknown` instead of USD 0.
ALTER TABLE cost_policies ADD COLUMN IF NOT EXISTS require_price_for text[] NOT NULL DEFAULT '{}';

ALTER TABLE cost_blocks ALTER COLUMN requested_usd DROP NOT NULL;
ALTER TABLE cost_blocks DROP CONSTRAINT IF EXISTS cost_blocks_reason_check;
ALTER TABLE cost_blocks ADD CONSTRAINT cost_blocks_reason_check CHECK (reason IN (
  'CAP_REACHED','DIMENSION_LIMIT','PAID_OP_NOT_PERMITTED','HARD_STOPPED','PRICE_UNKNOWN','GLOBAL_CEILING'));

CREATE TABLE IF NOT EXISTS cost_global_policy (
  id                  int PRIMARY KEY CHECK (id = 1),
  -- The owner may lower the ceiling; the table refuses anything above the authorised USD 5.
  model_ceiling_usd   numeric NOT NULL DEFAULT 5 CHECK (model_ceiling_usd >= 0 AND model_ceiling_usd <= 5),
  alert_thresholds    jsonb NOT NULL DEFAULT '[0.5,0.8,0.95]'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cost_global_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS cost_global_model_spend (
  entry_key     text PRIMARY KEY,
  usd           numeric CHECK (usd IS NULL OR usd >= 0),
  price_unknown boolean NOT NULL DEFAULT false,
  state         text NOT NULL CHECK (state IN ('reserved','settled','released')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  CHECK (price_unknown OR usd IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cost_global_model_spend_state_idx ON cost_global_model_spend (state, created_at);

GRANT SELECT, UPDATE ON cost_global_policy TO nearesis_app;
GRANT SELECT, INSERT, UPDATE ON cost_global_model_spend TO nearesis_app;

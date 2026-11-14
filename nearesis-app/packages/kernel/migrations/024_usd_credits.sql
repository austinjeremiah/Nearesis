-- Unified per-user USD credits (integer micro-USD). One balance pays for model calls and for OutLayer proofs / publication
-- anchor gas (converted from NEAR at the recorded daily rate). The NEAR credit tables of migration 022 stay, unused.
-- available = granted - spent - held. Every change runs in one transaction that first locks the account row.
CREATE TABLE usd_credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  granted_micro bigint NOT NULL CHECK (granted_micro >= 0),
  spent_micro bigint NOT NULL DEFAULT 0 CHECK (spent_micro >= 0),
  held_micro bigint NOT NULL DEFAULT 0 CHECK (held_micro >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usd_credit_within_grant CHECK (spent_micro + held_micro <= granted_micro)
);

CREATE TABLE usd_credit_entries (
  seq bigserial NOT NULL UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('grant','hold','charge','release')),
  category text NOT NULL CHECK (category IN ('model','outlayer','anchor','grant')),
  amount_micro bigint NOT NULL CHECK (amount_micro >= 0),
  ref_kind text,
  ref_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usd_credit_entries_user_idx ON usd_credit_entries(user_id, seq DESC);
-- A charge is idempotent per (user, ref_kind, ref_id, category): the backstop for the check inside the locked transaction.
CREATE UNIQUE INDEX usd_credit_charge_once ON usd_credit_entries(user_id, ref_kind, ref_id, category)
  WHERE kind = 'charge' AND ref_kind IS NOT NULL AND ref_id IS NOT NULL;

-- Runs that started before this migration are not charged (their spend predates the credits).
CREATE TABLE usd_credit_config (
  id int PRIMARY KEY CHECK (id = 1),
  charge_runs_from timestamptz NOT NULL DEFAULT now()
);
INSERT INTO usd_credit_config(id) VALUES (1);

ALTER TABLE usd_credit_accounts ENABLE ROW LEVEL SECURITY; ALTER TABLE usd_credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE usd_credit_entries ENABLE ROW LEVEL SECURITY;  ALTER TABLE usd_credit_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY usd_credit_owner ON usd_credit_accounts
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY usd_credit_owner ON usd_credit_entries
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
GRANT SELECT, INSERT, UPDATE ON usd_credit_accounts TO nearesis_app;
GRANT SELECT, INSERT ON usd_credit_entries TO nearesis_app;
GRANT SELECT ON usd_credit_config TO nearesis_app;
GRANT USAGE ON SEQUENCE usd_credit_entries_seq_seq TO nearesis_app;

-- OutLayer proofs: USD side of the cost (the yocto columns stay and keep the exact on-chain amounts).
ALTER TABLE outlayer_proofs ADD COLUMN held_micro bigint CHECK (held_micro >= 0);
ALTER TABLE outlayer_proofs ADD COLUMN charged_micro bigint CHECK (charged_micro >= 0);
ALTER TABLE outlayer_proofs ADD COLUMN gas_micro bigint CHECK (gas_micro >= 0);
ALTER TABLE outlayer_proofs ADD COLUMN total_micro bigint CHECK (total_micro >= 0);
ALTER TABLE outlayer_proofs ADD COLUMN near_usd_rate text;
ALTER TABLE outlayer_proofs ADD COLUMN rate_date date;

-- Startup recovery has no tenant context: running proofs that hold USD credits (held_micro is set only by the USD flow).
CREATE FUNCTION outlayer_proofs_running_usd()
RETURNS TABLE(id uuid, org_id uuid, requested_by uuid, tx_hash text, held_micro bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.org_id, p.requested_by, p.tx_hash, p.held_micro FROM outlayer_proofs p
   WHERE p.state = 'running' AND p.held_micro IS NOT NULL
$$;
REVOKE ALL ON FUNCTION outlayer_proofs_running_usd() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outlayer_proofs_running_usd() TO nearesis_app;

-- Model spend of runs not yet charged to the user who started them. Reads the runtime schema (owned by @nearesis/workflow)
-- late-bound, so this migration works before that schema exists (the function then reports a missing schema when called).
-- A run counts once it is terminal; a COMPLETE run waits for its interpretation stage (or 15 minutes) so late model calls
-- are included. The USD is what the run's own budget ledger recorded (kind 'charge').
CREATE FUNCTION usd_credit_uncharged_runs(p_user uuid DEFAULT NULL)
RETURNS TABLE(run_id uuid, tenant_id uuid, requested_by uuid, usd text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  SELECT r.id, r.tenant_id, r.requested_by, SUM(l.usd)::text
    FROM runtime.runs r
    JOIN runtime.budget_ledger l ON l.run_id = r.id AND l.kind = 'charge'
   WHERE r.requested_by IS NOT NULL
     AND (p_user IS NULL OR r.requested_by = p_user)
     AND r.created_at >= (SELECT c.charge_runs_from FROM public.usd_credit_config c WHERE c.id = 1)
     AND r.state IN ('COMPLETE','PARTIAL','BLOCKED','BLOCKED_SOURCE','CANCELLED')
     AND (r.state <> 'COMPLETE'
          OR r.updated_at < now() - interval '15 minutes'
          OR EXISTS (SELECT 1 FROM runtime.run_interpretation i WHERE i.run_id = r.id))
     AND NOT EXISTS (SELECT 1 FROM public.usd_credit_entries e
                      WHERE e.user_id = r.requested_by AND e.kind = 'charge' AND e.category = 'model'
                        AND e.ref_kind = 'run' AND e.ref_id = r.id::text)
   GROUP BY r.id, r.tenant_id, r.requested_by
  HAVING SUM(l.usd) > 0;
END $$;
REVOKE ALL ON FUNCTION usd_credit_uncharged_runs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usd_credit_uncharged_runs(uuid) TO nearesis_app;

-- Agent costs in USD: on-chain (OutLayer / anchor) amounts are recorded in USD with the NEAR detail. Legacy yoctoNEAR columns stay.
ALTER TABLE agent_cost_entries ADD COLUMN category text NOT NULL DEFAULT 'model' CHECK (category IN ('model','onchain'));
ALTER TABLE agent_cost_entries ADD COLUMN detail jsonb;
ALTER TABLE agent_task_steps ADD COLUMN credits_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (credits_usd >= 0);
ALTER TABLE agent_tasks ADD COLUMN credits_charged_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (credits_charged_usd >= 0);
ALTER TABLE agent_tasks ADD COLUMN credits_held_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (credits_held_usd >= 0);

-- Per-user credits (yoctoNEAR) and OutLayer proof jobs paid from the dev wallet and charged to the user's credits.
-- Amounts are numeric(40,0) (exact integers, up to ~1e40 yocto). available = balance - held. Every change to an account
-- runs in one transaction that first locks the account row (SELECT ... FOR UPDATE); the CHECKs are the backstop.
CREATE TABLE credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  balance_yocto numeric(40,0) NOT NULL DEFAULT 0 CHECK (balance_yocto >= 0),
  held_yocto numeric(40,0) NOT NULL DEFAULT 0 CHECK (held_yocto >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_held_within_balance CHECK (held_yocto <= balance_yocto)
);

CREATE TABLE credit_entries (
  seq bigserial NOT NULL UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('topup','hold','charge','release')),
  amount_yocto numeric(40,0) NOT NULL CHECK (amount_yocto >= 0),
  ref_kind text,
  ref_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_entries_user_idx ON credit_entries(user_id, seq DESC);

-- A transaction is credited once, ever.
CREATE TABLE credit_topups (
  tx_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  amount_yocto numeric(40,0) NOT NULL CHECK (amount_yocto > 0),
  signer_account_id text NOT NULL,
  receiver_account_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_topups_user_idx ON credit_topups(user_id);

CREATE TABLE outlayer_proofs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  capsule_id text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text,
  state text NOT NULL CHECK (state IN ('running','verified','not_attested','failed')),
  network text NOT NULL DEFAULT 'testnet' CHECK (network = 'testnet'),
  request_id text,
  tx_hash text,
  wasm_sha256 text NOT NULL,
  input_sha256 text NOT NULL,
  output_sha256 text,
  decision text CHECK (decision IN ('accept','reject')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  mr_td text,
  rtmr3 text,
  held_yocto numeric(40,0) NOT NULL CHECK (held_yocto >= 0),
  charged_yocto numeric(40,0) CHECK (charged_yocto >= 0),
  gas_yocto numeric(40,0) CHECK (gas_yocto >= 0),
  total_yocto numeric(40,0) CHECK (total_yocto >= 0),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX outlayer_proofs_capsule_idx ON outlayer_proofs(capsule_id, created_at DESC);
-- One running proof per capsule; one result per idempotency key and caller.
CREATE UNIQUE INDEX outlayer_proofs_running_capsule ON outlayer_proofs(capsule_id) WHERE state = 'running';
CREATE UNIQUE INDEX outlayer_proofs_idem ON outlayer_proofs(requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;  ALTER TABLE credit_accounts FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_entries ENABLE ROW LEVEL SECURITY;   ALTER TABLE credit_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_topups ENABLE ROW LEVEL SECURITY;    ALTER TABLE credit_topups FORCE ROW LEVEL SECURITY;
ALTER TABLE outlayer_proofs ENABLE ROW LEVEL SECURITY;  ALTER TABLE outlayer_proofs FORCE ROW LEVEL SECURITY;

CREATE POLICY credit_owner ON credit_accounts
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY credit_owner ON credit_entries
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY credit_owner ON credit_topups
  USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY proof_org ON outlayer_proofs
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));

-- Startup recovery has no tenant context: this definer function is the only unscoped read, limited to running jobs.
CREATE FUNCTION outlayer_proofs_running()
RETURNS TABLE(id uuid, org_id uuid, requested_by uuid, tx_hash text, held_yocto numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.id, p.org_id, p.requested_by, p.tx_hash, p.held_yocto FROM outlayer_proofs p WHERE p.state = 'running'
$$;
REVOKE ALL ON FUNCTION outlayer_proofs_running() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outlayer_proofs_running() TO nearesis_app;

GRANT SELECT, INSERT, UPDATE ON credit_accounts, outlayer_proofs TO nearesis_app;
GRANT SELECT, INSERT ON credit_entries, credit_topups TO nearesis_app;
GRANT USAGE ON SEQUENCE credit_entries_seq_seq TO nearesis_app;

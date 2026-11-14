CREATE SCHEMA IF NOT EXISTS runtime;
SET LOCAL search_path = runtime;

-- Agent runtime state (owned by @nearesis/workflow). Tables reference kernel entities by ID only (no FKs).
-- Every tenant-keyed table: ENABLE + FORCE ROW LEVEL SECURITY on current_setting('app.org_id', true).

CREATE TABLE IF NOT EXISTS runs (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  investigation_id uuid NOT NULL,
  question_id    uuid NOT NULL,
  snapshot_ref   text NOT NULL,
  budget_id      uuid NOT NULL,
  workflow_id    text NOT NULL,
  scenario       text,
  state          text NOT NULL CHECK (state IN ('REQUESTED','PLANNING','APPROVAL_NEEDED','EXECUTING','EVIDENCE_REVIEW','CANVAS_PATCH_REVIEW','COMPLETE','PARTIAL','BLOCKED','CANCELLED')),
  failure        jsonb,
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS run_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  run_id      uuid NOT NULL,
  source      text NOT NULL DEFAULT 'run',
  seq         int  NOT NULL,
  kind        text NOT NULL,
  from_state  text,
  to_state    text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source, seq)
);

CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  run_id         uuid NOT NULL,
  parent_task_id uuid,
  role           text NOT NULL,
  depth          int  NOT NULL CHECK (depth BETWEEN 0 AND 3),
  dedup_hash     text NOT NULL,
  dedup_key      jsonb NOT NULL,
  hypothesis_id  text NOT NULL,
  status         text NOT NULL CHECK (status IN ('QUEUED','RUNNING','WAITING_APPROVAL','DONE','FAILED','CANCELLED')),
  output_ref     text,
  workflow_id    text,
  objective      text,
  allowed_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_revoked  boolean NOT NULL DEFAULT false,
  budget_reserved jsonb,
  result         jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_dedup_unique UNIQUE (dedup_hash)
);
CREATE INDEX IF NOT EXISTS tasks_ws_status_idx ON tasks (workspace_id, status);

CREATE TABLE IF NOT EXISTS budgets (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  tokens_total     bigint  NOT NULL,
  tool_calls_total int     NOT NULL,
  usd_total        numeric NOT NULL
);

-- Reservations are made before execution (ch.05); charges are what was actually consumed; releases return the unused part.
CREATE TABLE IF NOT EXISTS budget_ledger (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  budget_id    uuid NOT NULL,
  run_id       uuid NOT NULL,
  task_id      uuid,
  entry_key    text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('reserve','charge','release')),
  tokens       bigint  NOT NULL DEFAULT 0,
  tool_calls   int     NOT NULL DEFAULT 0,
  usd          numeric NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Per-hypothesis tool-call ledger (A12 c). One row per accepted call key; replays of the same key do not recount.
CREATE TABLE IF NOT EXISTS tool_call_log (
  tenant_id     uuid NOT NULL,
  run_id        uuid NOT NULL,
  hypothesis_id text NOT NULL,
  call_key      text NOT NULL,
  n             int  NOT NULL,
  tool          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, hypothesis_id, call_key)
);

CREATE TABLE IF NOT EXISTS agent_side_effects (
  effect_key     text PRIMARY KEY,
  kind           text NOT NULL,
  run_id         uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  provider_calls int  NOT NULL DEFAULT 0,
  tenant_id      uuid NOT NULL,
  guarantee      text NOT NULL DEFAULT 'internal' CHECK (guarantee IN ('internal','external_idempotent','external_non_idempotent')),
  status         text NOT NULL DEFAULT 'started' CHECK (status IN ('started','done')),
  result         jsonb,
  accepted_at    timestamptz
);

CREATE TABLE IF NOT EXISTS approvals (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  run_id       uuid NOT NULL,
  action_hash  text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('approve','reject')),
  approved_by  text NOT NULL,
  network      text,
  cost_limit   numeric,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, action_hash, decision, approved_by)
);

CREATE TABLE IF NOT EXISTS agent_audit (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  workspace_id uuid,
  run_id       uuid,
  task_id      uuid,
  actor        text,
  kind         text NOT NULL,
  reason_code  text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Evidence index consulted by memory recall (A17). The authoritative evidence store belongs to Engine B / kernel;
-- this is a local resolvability mirror keyed by ID so memory can flag tombstoned evidence.
CREATE TABLE IF NOT EXISTS agent_evidence_refs (
  tenant_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  evidence_id  text NOT NULL,
  tombstoned   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS agent_memory (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  agent_role    text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('role','workspace')),
  tier          text NOT NULL CHECK (tier IN ('episodic','semantic')),
  content       text NOT NULL,
  evidence_id   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_memory_ns_idx ON agent_memory (tenant_id, workspace_id, agent_role, scope);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['runs','run_events','tasks','budgets','budget_ledger','tool_call_log','agent_side_effects','approvals','agent_audit','agent_evidence_refs','agent_memory']
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
-- Memory is additionally confined to the workspace when the session declares one (app.workspace_id).
DROP POLICY IF EXISTS tenant_isolation ON agent_memory;
CREATE POLICY tenant_isolation ON agent_memory
  USING (tenant_id = NULLIF(current_setting('app.org_id', true), '')::uuid
         AND (NULLIF(current_setting('app.workspace_id', true), '') IS NULL
              OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid))
  WITH CHECK (tenant_id = NULLIF(current_setting('app.org_id', true), '')::uuid
         AND (NULLIF(current_setting('app.workspace_id', true), '') IS NULL
              OR workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid));

GRANT USAGE ON SCHEMA runtime TO nearesis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA runtime TO nearesis_app;

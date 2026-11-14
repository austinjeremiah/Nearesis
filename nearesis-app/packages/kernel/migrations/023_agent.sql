-- Agent v2: user-tied threads, messages, planned tasks with live steps and per-step costs.
-- Everything is owned by one user (and the organisation of the session that created it); row-level security keys on the user,
-- so a user never sees another user's thread. USD amounts are numeric(14,6); yoctoNEAR amounts are exact integers.
CREATE TABLE agent_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL DEFAULT 'New conversation' CHECK (char_length(title) BETWEEN 1 AND 200),
  workspace_id uuid REFERENCES workspaces(id),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_threads_user_idx ON agent_threads(user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES agent_threads(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_id uuid REFERENCES workspaces(id),
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('proposed','running','waiting_user','completed','failed','cancelled')),
  current_step int NOT NULL DEFAULT 0,
  consent_required jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_given jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimate jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- ids the steps produced and later steps consume (workspaceId, runId, capsuleId, proofId, publicationId, hypothesisId)
  ctx jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (model_usd >= 0),
  model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  credits_charged_yocto numeric(40,0) NOT NULL DEFAULT 0 CHECK (credits_charged_yocto >= 0),
  credits_held_yocto numeric(40,0) NOT NULL DEFAULT 0 CHECK (credits_held_yocto >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX agent_tasks_thread_idx ON agent_tasks(thread_id, created_at);
-- One active (running or waiting) task per user.
CREATE UNIQUE INDEX agent_tasks_one_active ON agent_tasks(user_id) WHERE state IN ('running','waiting_user');

CREATE TABLE agent_messages (
  seq bigserial NOT NULL UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES agent_threads(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  state text NOT NULL CHECK (state IN ('pending','ready','failed')),
  kind text NOT NULL CHECK (kind IN ('text','answer','plan','result','notice')),
  text text,
  answer jsonb,
  result jsonb,
  task_id uuid REFERENCES agent_tasks(id),
  model_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (model_usd >= 0),
  model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_messages_thread_idx ON agent_messages(thread_id, seq);

CREATE TABLE agent_task_steps (
  task_id uuid NOT NULL REFERENCES agent_tasks(id),
  idx int NOT NULL CHECK (idx >= 0),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  title text NOT NULL,
  detail text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','waiting_user','done','failed','skipped')),
  started_at timestamptz,
  finished_at timestamptz,
  progress text,
  result jsonb,
  waiting jsonb,
  error jsonb,
  model_usd numeric(14,6) NOT NULL DEFAULT 0 CHECK (model_usd >= 0),
  model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  credits_yocto numeric(40,0) NOT NULL DEFAULT 0 CHECK (credits_yocto >= 0),
  PRIMARY KEY (task_id, idx)
);

CREATE TABLE agent_cost_entries (
  seq bigserial NOT NULL UNIQUE,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  thread_id uuid REFERENCES agent_threads(id),
  task_id uuid REFERENCES agent_tasks(id),
  message_id uuid REFERENCES agent_messages(id),
  step_idx int,
  step_key text,
  label text NOT NULL,
  unit text NOT NULL CHECK (unit IN ('usd','yoctoNEAR')),
  amount numeric(60,6) NOT NULL CHECK (amount >= 0),
  tx_hash text,
  -- A cost is recorded once per source (for example one credits ledger entry), so a retry never double counts.
  source_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_cost_entries_user_idx ON agent_cost_entries(user_id, seq DESC);
CREATE UNIQUE INDEX agent_cost_entries_source ON agent_cost_entries(user_id, source_key) WHERE source_key IS NOT NULL;

ALTER TABLE agent_threads ENABLE ROW LEVEL SECURITY;      ALTER TABLE agent_threads FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;        ALTER TABLE agent_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_messages ENABLE ROW LEVEL SECURITY;     ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_task_steps ENABLE ROW LEVEL SECURITY;   ALTER TABLE agent_task_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_cost_entries ENABLE ROW LEVEL SECURITY; ALTER TABLE agent_cost_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY agent_owner ON agent_threads USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY agent_owner ON agent_tasks USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY agent_owner ON agent_messages USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY agent_owner ON agent_task_steps USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
CREATE POLICY agent_owner ON agent_cost_entries USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());

-- Startup recovery has no tenant context: this definer function is the only unscoped read, limited to active tasks and
-- assistant replies still pending (their background work died with the previous process).
CREATE FUNCTION agent_recovery_scan()
RETURNS TABLE(kind text, id uuid, org_id uuid, user_id uuid, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'task'::text, t.id, t.org_id, t.user_id, t.state FROM agent_tasks t WHERE t.state IN ('running','waiting_user')
  UNION ALL
  SELECT 'message'::text, m.id, m.org_id, m.user_id, m.state FROM agent_messages m WHERE m.state = 'pending'
$$;
REVOKE ALL ON FUNCTION agent_recovery_scan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_recovery_scan() TO nearesis_app;

GRANT SELECT, INSERT, UPDATE ON agent_threads, agent_tasks, agent_messages, agent_task_steps TO nearesis_app;
GRANT SELECT, INSERT ON agent_cost_entries TO nearesis_app;
GRANT USAGE ON SEQUENCE agent_messages_seq_seq, agent_cost_entries_seq_seq TO nearesis_app;

-- P06 completion (ch.16b M08-M16): per-evaluation records keyed on rule version, data maturity and run caps, replay flag
-- on markers, task reason codes, the delegation scope and chain, and the scheduler lease history.

ALTER TABLE monitor_rules ADD COLUMN semantic_version text;
ALTER TABLE monitor_rules ADD COLUMN data_maturity text NOT NULL DEFAULT 'finalized_only'
  CHECK (data_maturity IN ('finalized_only','any'));
ALTER TABLE monitor_rules ADD COLUMN max_runs_per_day integer CHECK (max_runs_per_day IS NULL OR max_runs_per_day > 0);

ALTER TABLE markers ADD COLUMN mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay'));
ALTER TABLE markers ADD COLUMN reason_code text;
ALTER TABLE markers ADD COLUMN delegate_to uuid;

ALTER TABLE marker_tasks ADD COLUMN reason_code text;
ALTER TABLE marker_tasks ADD COLUMN grants jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE source_watermark_events ADD COLUMN maturity text NOT NULL DEFAULT 'final'
  CHECK (maturity IN ('final','provisional'));

-- A replay notification is in-app only; only live notifications are eligible for external channels.
ALTER TABLE notifications ADD COLUMN external_eligible boolean NOT NULL DEFAULT false;
UPDATE notifications SET external_eligible = (mode = 'live');

-- Every event a rule sees is recorded once. Unique on the ch.20 key (rule, watermark, rule version) plus mode.
CREATE TABLE monitor_evaluations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  rule_id uuid NOT NULL REFERENCES monitor_rules(id),
  rule_version integer NOT NULL,
  semantic_version text,
  source_id text NOT NULL,
  watermark timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live','replay')),
  status text NOT NULL CHECK (status IN ('fired','condition_false','debounced','cooldown','frequency','no_data',
                                         'not_final','suppressed_run_cap','skipped_disabled')),
  evaluated_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger_id uuid,
  task_id uuid,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, watermark, rule_version, mode)
);
CREATE INDEX monitor_evaluations_rule_idx ON monitor_evaluations(rule_id, mode, watermark);
CREATE INDEX monitor_evaluations_ws_idx ON monitor_evaluations(workspace_id, evaluated_at DESC);

CREATE TABLE delegation_scopes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL,
  agents jsonb NOT NULL,
  grants jsonb NOT NULL,
  delegate_to jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_budget jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

-- (user, marker, agents, grants) per spawned child, with the parent link and depth for nested delegation.
CREATE TABLE marker_delegations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  marker_id uuid NOT NULL REFERENCES markers(id),
  task_id uuid NOT NULL,
  delegator_user_id uuid,
  agents jsonb NOT NULL,
  grants jsonb NOT NULL,
  parent_delegation_id uuid,
  depth integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marker_delegations_marker_idx ON marker_delegations(marker_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['monitor_evaluations','delegation_scopes','marker_delegations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON monitor_evaluations, delegation_scopes, marker_delegations TO nearesis_app;

-- Platform-global lease history: who held the single scheduler lease, and until when (never overlaps).
CREATE TABLE monitor_scheduler_lease_history (
  name text NOT NULL,
  fence bigint NOT NULL,
  holder text NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  PRIMARY KEY (name, fence)
);
GRANT SELECT, INSERT, UPDATE ON monitor_scheduler_lease_history TO nearesis_app;

-- The scheduler must see disabled rules too, so every event they receive is recorded as skipped (never silently dropped).
DROP FUNCTION monitor_rules_for_source(text);
CREATE FUNCTION monitor_rules_for_source(p_source text)
RETURNS TABLE(rule_id uuid, org_id uuid, workspace_id uuid, created_by uuid, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.org_id, r.workspace_id, r.created_by, r.enabled FROM monitor_rules r WHERE r.source_id = p_source
$$;
REVOKE ALL ON FUNCTION monitor_rules_for_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_rules_for_source(text) TO nearesis_app;

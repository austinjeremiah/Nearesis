-- P06 monitoring (ch.09 marker state machine, refresh architecture; ch.15 P06): full marker fields, lenses, monitor
-- rules, per-(rule, watermark, mode) triggers, notifications, marker tasks, plus the platform-global source-watermark
-- inbox and the single-owner scheduler lease. Tenant tables use the same RLS policy as every other kernel table.

-- generated from the anchor so every writer (command bus, canvas patch) stays consistent
ALTER TABLE markers ADD COLUMN anchor_type text GENERATED ALWAYS AS (anchor_json->>'kind') STORED;
ALTER TABLE markers ADD COLUMN source_version integer NOT NULL DEFAULT 0;
ALTER TABLE markers ADD COLUMN assigned_agents jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE markers ADD COLUMN linked_evidence_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE markers ADD COLUMN monitor_rule_id uuid;
ALTER TABLE markers ADD COLUMN resolution text;
ALTER TABLE markers ADD COLUMN selection_json jsonb;
ALTER TABLE markers ADD CONSTRAINT markers_anchor_type_chk
  CHECK (anchor_type IN ('time_point','time_range','threshold','source_event'));
CREATE INDEX markers_ws_idx ON markers(workspace_id);

CREATE TABLE lenses (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  panel_ids jsonb NOT NULL,
  filter_json jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX lenses_ws_idx ON lenses(workspace_id);

CREATE TABLE monitor_rules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  marker_id uuid,
  source_id text NOT NULL,
  condition_json jsonb NOT NULL,
  min_interval_seconds integer NOT NULL DEFAULT 0,
  debounce_seconds integer NOT NULL DEFAULT 0,
  cooldown_seconds integer NOT NULL DEFAULT 0,
  action text NOT NULL DEFAULT 'notify' CHECK (action IN ('notify','investigate')),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  -- evaluation state (watermark time, so replay and live share one deterministic clock per mode)
  state_json jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {live:{lastEvaluatedAt,trueSince,lastFiredAt}, replay:{...}}
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX monitor_rules_ws_idx ON monitor_rules(workspace_id);
CREATE INDEX monitor_rules_source_idx ON monitor_rules(source_id) WHERE enabled;

CREATE TABLE monitor_triggers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  rule_id uuid NOT NULL REFERENCES monitor_rules(id),
  source_id text NOT NULL,
  watermark timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live','replay')),
  outcome text NOT NULL,
  observed jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_id uuid,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  -- the competing-worker dedupe: one evaluation per (rule, watermark, mode), enforced by the database
  UNIQUE (rule_id, watermark, mode)
);
CREATE INDEX monitor_triggers_ws_idx ON monitor_triggers(workspace_id, evaluated_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  rule_id uuid NOT NULL REFERENCES monitor_rules(id),
  trigger_id uuid NOT NULL,
  marker_id uuid,
  mode text NOT NULL CHECK (mode IN ('live','replay')),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  read_by uuid
);
CREATE INDEX notifications_ws_idx ON notifications(workspace_id, created_at DESC);

CREATE TABLE marker_tasks (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  marker_id uuid NOT NULL REFERENCES markers(id),
  origin text NOT NULL CHECK (origin IN ('assign','rule')),
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live','replay')),
  trigger_id uuid,
  requested_by uuid,
  agents jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget jsonb,
  run_id uuid,
  workflow_id text,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','COMPLETE','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX marker_tasks_marker_idx ON marker_tasks(marker_id);
-- A trigger starts at most one task, however many workers race.
CREATE UNIQUE INDEX marker_tasks_trigger_uq ON marker_tasks(trigger_id) WHERE trigger_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lenses','monitor_rules','monitor_triggers','notifications','marker_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON lenses, monitor_rules, monitor_triggers, notifications, marker_tasks TO nearesis_app;

-- Platform-global (no tenant content): public source watermark updates, and the single-owner scheduler lease.
CREATE TABLE source_watermark_events (
  id bigserial PRIMARY KEY,
  source_id text NOT NULL,
  watermark timestamptz NOT NULL,
  mode text NOT NULL CHECK (mode IN ('live','replay')),
  values_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, watermark, mode)
);
CREATE TABLE monitor_scheduler_lease (
  name text PRIMARY KEY,
  holder text NOT NULL,
  fence bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  cursor_id bigint NOT NULL DEFAULT 0
);
GRANT SELECT, INSERT, UPDATE ON source_watermark_events, monitor_scheduler_lease TO nearesis_app;
GRANT USAGE ON SEQUENCE source_watermark_events_id_seq TO nearesis_app;

-- Unscoped read of "which enabled rules listen to this source" for the scheduler; returns identifiers only.
CREATE FUNCTION monitor_rules_for_source(p_source text)
RETURNS TABLE(rule_id uuid, org_id uuid, workspace_id uuid, created_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.id, r.org_id, r.workspace_id, r.created_by FROM monitor_rules r WHERE r.source_id = p_source AND r.enabled
$$;
REVOKE ALL ON FUNCTION monitor_rules_for_source(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_rules_for_source(text) TO nearesis_app;

-- Unscoped read of open marker tasks for the dispatcher (identifiers only; the dispatcher re-enters tenant context).
CREATE FUNCTION monitor_open_tasks()
RETURNS TABLE(task_id uuid, org_id uuid, workspace_id uuid, marker_id uuid, status text, requested_by uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.org_id, t.workspace_id, t.marker_id, t.status, t.requested_by FROM marker_tasks t
   WHERE t.status IN ('PENDING','RUNNING') ORDER BY t.created_at
$$;
REVOKE ALL ON FUNCTION monitor_open_tasks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitor_open_tasks() TO nearesis_app;

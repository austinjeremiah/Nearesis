-- Plugin registry (platform-global), per-workspace enablement, capability leases, incidents, tool invocations.

CREATE TABLE plugin_installations (
  id uuid PRIMARY KEY,
  plugin_id text NOT NULL,
  version text NOT NULL,
  major integer NOT NULL,
  api_version integer NOT NULL,
  manifest jsonb NOT NULL,
  trust text NOT NULL CHECK (trust IN ('production','dev_trust')),
  state text NOT NULL CHECK (state IN ('installed','enabled','disabled','degraded','quarantined')),
  state_reason text,
  active boolean NOT NULL DEFAULT false,
  consecutive_failures integer NOT NULL DEFAULT 0,
  installed_by uuid,
  installed_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz,
  activated_from uuid,          -- version this one replaced (rollback target)
  UNIQUE (plugin_id, version)
);
CREATE UNIQUE INDEX plugin_one_active ON plugin_installations(plugin_id) WHERE active;

CREATE TABLE workspace_plugins (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  plugin_id text NOT NULL,
  pinned_major integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  enabled_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE capability_leases (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  holder_actor_id uuid NOT NULL,
  capability text NOT NULL,
  grants jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  parent_lease_id uuid REFERENCES capability_leases(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leases_holder_idx ON capability_leases(workspace_id, holder_actor_id);

CREATE TABLE plugin_incidents (
  id uuid PRIMARY KEY,
  plugin_id text NOT NULL,
  installation_id uuid NOT NULL REFERENCES plugin_installations(id),
  kind text NOT NULL,
  detail text NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE TABLE tool_invocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  actor_id uuid NOT NULL,
  capability text NOT NULL,
  installation_id uuid,
  plugin_version text,
  state text NOT NULL DEFAULT 'running',
  reason_code text,
  result_sha256 text,
  response jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_plugins','capability_leases','tool_invocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;

-- Operator view: which workspaces (any tenant) depend on a plugin. engine.inspect() is an operator surface.
CREATE FUNCTION operator_plugin_dependents()
RETURNS TABLE(plugin_id text, workspace_id uuid, pinned_major integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT plugin_id, workspace_id, pinned_major FROM workspace_plugins WHERE enabled
$$;
REVOKE ALL ON FUNCTION operator_plugin_dependents() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_plugin_dependents() TO nearesis_app;

-- Declared-migration upgrades re-pin dependent workspaces across tenants (operator action).
CREATE FUNCTION operator_repin_workspaces(p_plugin text, p_from integer, p_to integer) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE workspace_plugins SET pinned_major = p_to, updated_at = now()
             WHERE plugin_id = p_plugin AND pinned_major = p_from RETURNING 1)
  SELECT count(*)::integer FROM u
$$;
REVOKE ALL ON FUNCTION operator_repin_workspaces(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_repin_workspaces(text, integer, integer) TO nearesis_app;

GRANT SELECT, INSERT, UPDATE ON plugin_installations, workspace_plugins, plugin_incidents, capability_leases,
  tool_invocations TO nearesis_app;

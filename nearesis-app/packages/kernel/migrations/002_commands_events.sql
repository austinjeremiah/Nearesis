-- Command journal, event log, outbox, consumer receipts, audit, plus minimal panels/markers for tenancy tests.

CREATE TABLE create_requests (
  org_id uuid NOT NULL REFERENCES organizations(id),
  idempotency_key text NOT NULL,
  actor_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  payload_hash text NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, idempotency_key)
);

CREATE TABLE commands (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  idempotency_key text NOT NULL,
  expected_version integer NOT NULL,
  actor_id uuid NOT NULL,
  command_type text NOT NULL,
  payload_hash text NOT NULL,
  applied_seq integer NOT NULL,
  workspace_version integer NOT NULL,
  result_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE workspace_events (
  event_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  seq integer NOT NULL CHECK (seq > 0),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  actor_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  causation_id text,
  correlation_id text,
  source_revision integer,
  schema_version integer NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, seq)
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  event_id uuid NOT NULL REFERENCES workspace_events(event_id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  topic text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending_idx ON outbox(created_at) WHERE published_at IS NULL;

CREATE TABLE consumer_receipts (
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),   -- NULL = platform-level (plugin install etc.)
  workspace_id uuid,
  actor_id uuid,
  action text NOT NULL,
  subject text,
  outcome text NOT NULL,
  reason_code text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_action_idx ON audit_events(action, occurred_at);

CREATE TABLE panels (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE markers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  branch_id uuid,
  panel_id uuid NOT NULL REFERENCES panels(id),
  anchor_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  version integer NOT NULL DEFAULT 1,
  monitor_id uuid
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['create_requests','workspace_events','outbox','consumer_receipts','panels','markers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;  ALTER TABLE commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commands
  USING (app_can_access_org(tenant_id)) WITH CHECK (app_can_access_org(tenant_id));
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
-- Platform rows (org_id NULL) can be appended by anyone but are invisible to tenants.
CREATE POLICY audit_read ON audit_events FOR SELECT USING (org_id IS NOT NULL AND org_id = app_org_id());
CREATE POLICY audit_append ON audit_events FOR INSERT WITH CHECK (org_id IS NULL OR org_id = app_org_id());

-- Events and audit are append-only for the app role.
GRANT SELECT, INSERT ON workspace_events, audit_events, commands, create_requests, consumer_receipts TO nearesis_app;
GRANT SELECT, INSERT, UPDATE ON outbox, panels, markers TO nearesis_app;

-- Outbox workers run without a tenant context. These definer functions are the only cross-tenant access and expose
-- exactly the claim/settle operations (ch.10: publish only after commit; re-delivery deduplicated by consumers).
CREATE FUNCTION outbox_claim(p_limit integer)
RETURNS TABLE(outbox_id uuid, event_id uuid, org_id uuid, workspace_id uuid, topic text, attempts integer,
              seq integer, event_type text, payload jsonb, payload_hash text, actor_id uuid, occurred_at timestamptz,
              causation_id text, correlation_id text, source_revision integer, schema_version integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.event_id, o.org_id, o.workspace_id, o.topic, o.attempts,
         e.seq, e.event_type, e.payload, e.payload_hash, e.actor_id, e.occurred_at, e.causation_id, e.correlation_id,
         e.source_revision, e.schema_version
  FROM outbox o JOIN workspace_events e ON e.event_id = o.event_id
  WHERE o.published_at IS NULL
  ORDER BY o.created_at, e.seq
  LIMIT p_limit
  FOR UPDATE OF o SKIP LOCKED
$$;
CREATE FUNCTION outbox_settle(p_id uuid, p_ok boolean, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox SET attempts = attempts + 1,
    published_at = CASE WHEN p_ok THEN now() ELSE published_at END,
    last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  WHERE id = p_id
$$;
REVOKE ALL ON FUNCTION outbox_claim(integer), outbox_settle(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim(integer), outbox_settle(uuid, boolean, text) TO nearesis_app;

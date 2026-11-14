-- History acceptance support (W07-W18): actor attribution on the journal, node ACL, revalidation queue, snapshot
-- retention purge, reviewer comments, agent summaries, branch input maps and memory copies, a content-addressed object
-- store with retention tombstones, public assets and object lineage. All additive.

-- W12: every event records whether a human or an agent caused it (server-set from the session GUC, never from clients).
ALTER TABLE workspace_events ADD COLUMN actor_kind text NOT NULL DEFAULT app_actor_kind();

-- W09: node-level restriction and revalidation queue with a visible backlog.
ALTER TABLE evidence_nodes ADD COLUMN restricted boolean NOT NULL DEFAULT false;
CREATE TABLE evidence_node_grants (
  node_id uuid NOT NULL REFERENCES evidence_nodes(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  granted_by uuid,
  PRIMARY KEY (node_id, user_id)
);
CREATE TABLE revalidation_tasks (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  node_id uuid NOT NULL,
  metric_id text NOT NULL,
  to_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('created','queued','done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, node_id, metric_id, to_version)
);

-- W11 / W18: a retention purge removes a snapshot's payload but keeps its identity and content hash. The trigger lets
-- the application role do exactly that and nothing else to a snapshot row.
ALTER TABLE history_snapshots ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE history_snapshots ADD COLUMN purged_at timestamptz;
ALTER TABLE history_snapshots ADD COLUMN purge_reason text;
GRANT UPDATE (payload, purged_at, purge_reason) ON history_snapshots TO nearesis_app;
CREATE FUNCTION history_snapshots_purge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.payload IS NULL OR NEW.payload IS NOT NULL OR NEW.purged_at IS NULL OR NEW.purge_reason IS NULL THEN
    RAISE EXCEPTION 'history snapshots are immutable except for a retention purge' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_snapshots_purge_guard BEFORE UPDATE ON history_snapshots
  FOR EACH ROW EXECUTE FUNCTION history_snapshots_purge_guard();

-- W12: reviewer comments are never evidence.
CREATE TABLE review_comments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  target_node_id uuid NOT NULL,
  author_id uuid NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('human','agent','service')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- W17: agent and human summaries live apart from evidence and may go stale without touching their sources.
CREATE TABLE history_summaries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  author_id uuid NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('human','agent','service')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  metric_pins jsonb NOT NULL DEFAULT '{}'::jsonb,
  stale boolean NOT NULL DEFAULT false,
  stale_reason text,
  stale_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT UPDATE (stale, stale_reason, stale_at) ON history_summaries TO nearesis_app;

-- W13: frozen input version map, a snapshot copy of agent memory for the branch scope.
ALTER TABLE history_branches ADD COLUMN input_version_map jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE TABLE branch_memory_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  branch_id uuid NOT NULL,
  copied_from uuid NOT NULL,
  body text NOT NULL,
  source_refs jsonb NOT NULL,
  author_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- W14: merge items excluded by policy keep their reason.
ALTER TABLE history_merge_proposals ADD COLUMN excluded jsonb NOT NULL DEFAULT '[]'::jsonb;

-- W13 / W18: tenant-scoped content-addressed object store, and the retention tombstone fields.
CREATE TABLE raw_objects (
  org_id uuid NOT NULL REFERENCES organizations(id),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  size_bytes integer NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, hash)
);
ALTER TABLE evidence_nodes ADD COLUMN raw_object_hash text;
ALTER TABLE evidence_nodes ADD COLUMN content_hash text;
ALTER TABLE evidence_nodes ADD COLUMN deleted_at timestamptz;
ALTER TABLE evidence_nodes ADD COLUMN public_asset_id uuid;
CREATE TABLE retention_queue (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  content_hash text NOT NULL,
  action text NOT NULL CHECK (action IN ('purge_backups')),
  reason text NOT NULL,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- W13: copying an object into another workspace creates a new item with a lineage link, never a live link.
CREATE TABLE object_lineage (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  object_id text NOT NULL,
  source_workspace_id uuid NOT NULL,
  source_object_id text NOT NULL,
  copied_by uuid NOT NULL,
  copied_at timestamptz NOT NULL DEFAULT now()
);

-- W16: layout entries that no longer resolve to a canvas panel are dropped with a recorded notice.
CREATE TABLE collab_notices (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  scope text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- W18: assets shared across workspaces on purpose (public, immutable, content-addressed). Readable by any tenant.
CREATE TABLE public_assets (
  id uuid PRIMARY KEY,
  content_hash text NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_node_grants','revalidation_tasks','review_comments','history_summaries',
                           'branch_memory_items','raw_objects','retention_queue','object_lineage','collab_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;

GRANT DELETE ON evidence_node_grants TO nearesis_app;
GRANT SELECT, INSERT ON evidence_node_grants, review_comments, history_summaries, branch_memory_items,
  object_lineage, collab_notices, retention_queue, public_assets TO nearesis_app;
GRANT SELECT, INSERT, UPDATE ON revalidation_tasks TO nearesis_app;
GRANT SELECT, INSERT, DELETE ON raw_objects TO nearesis_app;
GRANT USAGE, SELECT ON SEQUENCE collab_notices_id_seq TO nearesis_app;

-- Evidence graph completion and time machine (ch.10): typed nodes, tombstones, semantic-version impact flags,
-- immutable snapshots, branches with overlays, merge proposals, Yjs update log. Layout stays in graph_layouts and the
-- Yjs log, never in evidence semantics.

ALTER TABLE evidence_nodes DROP CONSTRAINT evidence_nodes_kind_check;
ALTER TABLE evidence_nodes ADD CONSTRAINT evidence_nodes_kind_check CHECK (kind IN (
  'hypothesis','observation','query','model','source','marker','agent',
  'statistical_result','claim','verification_artifact'));
ALTER TABLE evidence_nodes ADD COLUMN tombstone boolean NOT NULL DEFAULT false;
ALTER TABLE evidence_nodes ADD COLUMN tombstone_reason text;
ALTER TABLE evidence_nodes ADD COLUMN semantic_pins jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE evidence_edges ADD COLUMN reason text;

CREATE TABLE evidence_node_flags (
  node_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  metric_id text NOT NULL,
  from_version text,
  to_version text NOT NULL,
  via text NOT NULL CHECK (via IN ('pinned','derived_from')),
  flagged_by uuid,
  flagged_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text,
  PRIMARY KEY (node_id, metric_id, to_version)
);
CREATE INDEX evidence_node_flags_ws_idx ON evidence_node_flags(workspace_id) WHERE resolved_at IS NULL;

CREATE TABLE semantic_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  metric_id text NOT NULL,
  seq integer NOT NULL,
  version text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, metric_id, seq)
);

CREATE TABLE history_snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  branch_id uuid NOT NULL,
  label text NOT NULL,
  event_seq integer NOT NULL,
  workspace_version integer NOT NULL,
  document_revision integer NOT NULL,
  data_revision integer NOT NULL,
  content_hash text NOT NULL,
  payload jsonb NOT NULL,
  data_vintage jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_snapshots_ws_idx ON history_snapshots(workspace_id, created_at);

CREATE TABLE history_branches (
  branch_id uuid PRIMARY KEY REFERENCES branches(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text,
  base_snapshot_id uuid NOT NULL REFERENCES history_snapshots(id),
  overlay jsonb NOT NULL DEFAULT '{}'::jsonb,
  overlay_revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE history_merge_proposals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_branch_id uuid NOT NULL,
  target_branch_id uuid NOT NULL,
  base_snapshot_id uuid NOT NULL REFERENCES history_snapshots(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','rejected')),
  changes jsonb NOT NULL,
  conflicts jsonb NOT NULL,
  evidence_hash_diffs jsonb NOT NULL,
  upstream jsonb NOT NULL,
  required_approvals jsonb NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz
);
CREATE INDEX history_merge_ws_idx ON history_merge_proposals(workspace_id, created_at);

CREATE TABLE collab_updates (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  scope text NOT NULL CHECK (scope IN ('layout','notes')),
  update bytea NOT NULL,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_updates_ws_idx ON collab_updates(workspace_id, scope, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_node_flags','semantic_versions','history_snapshots','history_branches',
                           'history_merge_proposals','collab_updates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;

-- Snapshots, semantic versions and the Yjs log are append-only for the app role.
GRANT SELECT, INSERT ON history_snapshots, semantic_versions, collab_updates TO nearesis_app;
GRANT SELECT, INSERT, UPDATE ON evidence_node_flags, history_branches, history_merge_proposals TO nearesis_app;
GRANT USAGE, SELECT ON SEQUENCE collab_updates_id_seq TO nearesis_app;

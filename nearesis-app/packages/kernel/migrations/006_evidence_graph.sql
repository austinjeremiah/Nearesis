-- Evidence graph (ch.10 / ch.26): typed nodes and relation edges beyond what is derivable from canvas entities, plus
-- the per-workspace layout. Panels (query nodes), markers and runtime agents are projected from their own tables.

CREATE TABLE evidence_nodes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL CHECK (kind IN ('hypothesis','observation','query','model','source','marker','agent')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 500),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_nodes_ws_idx ON evidence_nodes(workspace_id);

CREATE TABLE evidence_edges (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  from_node uuid NOT NULL,
  to_node uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('supports','contradicts','derived_from','monitors','references','reproduces','supersedes')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, from_node, to_node, relation)
);
CREATE INDEX evidence_edges_ws_idx ON evidence_edges(workspace_id);

CREATE TABLE graph_layouts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  positions jsonb NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['evidence_nodes','evidence_edges','graph_layouts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON evidence_nodes, evidence_edges, graph_layouts TO nearesis_app;

-- Data classification labels (SEC21). A subject with no row is `private`: the safe default for anything unlabelled.
CREATE TABLE data_classifications (
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('evidence_node','snapshot','panel_field','note','draft')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 200),
  label text NOT NULL CHECK (label IN ('private','internal','public')),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, subject_kind, subject_id)
);
ALTER TABLE data_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON data_classifications
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT, INSERT, UPDATE ON data_classifications TO nearesis_app;

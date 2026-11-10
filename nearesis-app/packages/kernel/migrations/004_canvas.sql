-- Canvas persistence (kernel-owned, ch.09/ch.10): documents, panel specs, markers. dataRevision is kept separate from
-- documentRevision (C18). panels (002) remains the identity table that markers reference.

ALTER TABLE panels ADD COLUMN removed_at timestamptz;

CREATE TABLE canvas_documents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  branch_id uuid NOT NULL,
  layout_json jsonb NOT NULL,                  -- viewport, layoutMode, activeSelections
  revision integer NOT NULL DEFAULT 0,         -- documentRevision
  data_revision integer NOT NULL DEFAULT 0,    -- dataRevision (bumped by data refresh, never by layout patches)
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, branch_id)
);

CREATE TABLE panel_specs (
  id uuid PRIMARY KEY REFERENCES panels(id),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  document_id uuid NOT NULL REFERENCES canvas_documents(id),
  query_hash text NOT NULL,
  schema_version integer NOT NULL,
  kind text NOT NULL,
  spec jsonb NOT NULL,
  layout_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX panel_specs_doc_idx ON panel_specs(document_id);

ALTER TABLE markers ADD COLUMN question text;
ALTER TABLE markers ADD COLUMN created_by uuid;
ALTER TABLE markers ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE markers ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE markers ADD CONSTRAINT markers_status_chk
  CHECK (status IN ('DRAFT','ACTIVE','INVESTIGATING','REVIEW_REQUIRED','RESOLVED','MONITORING','DISMISSED'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['canvas_documents','panel_specs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON canvas_documents, panel_specs TO nearesis_app;

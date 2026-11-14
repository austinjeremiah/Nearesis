-- Patch log with exact inverse operations (undo, C06) and marker deletion for removeMarker.
CREATE TABLE canvas_patches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  document_id uuid NOT NULL REFERENCES canvas_documents(id),
  operation_id uuid NOT NULL,
  revision integer NOT NULL,              -- documentRevision after the patch
  patch jsonb NOT NULL,
  inverse jsonb NOT NULL,
  preview_hash text NOT NULL,
  applied_by uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, revision),
  UNIQUE (workspace_id, operation_id)
);
ALTER TABLE canvas_patches ENABLE ROW LEVEL SECURITY;
ALTER TABLE canvas_patches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON canvas_patches
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT, INSERT ON canvas_patches TO nearesis_app;
GRANT DELETE ON markers TO nearesis_app;

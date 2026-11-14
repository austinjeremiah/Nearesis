-- Integrity chain (SEC13): a stored artefact whose bytes no longer match its recorded hash is quarantined and never used.
-- org_id is NULL for platform-level artefacts (plugin manifests, semantic models, capsules).

CREATE TABLE integrity_quarantine (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  artefact_class text NOT NULL CHECK (artefact_class IN
    ('archive_object','evidence_item','outbox_event','plugin_manifest','semantic_model','capsule')),
  ref text NOT NULL,
  expected_hash text NOT NULL,
  actual_hash text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (artefact_class, ref, actual_hash)
);
CREATE INDEX integrity_quarantine_ref_idx ON integrity_quarantine(artefact_class, ref);

ALTER TABLE integrity_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrity_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY quarantine_visibility ON integrity_quarantine
  USING (org_id IS NULL OR app_can_access_org(org_id))
  WITH CHECK (org_id IS NULL OR app_can_access_org(org_id));
GRANT SELECT, INSERT ON integrity_quarantine TO nearesis_app;

-- Hash of the installed manifest at install time, re-checked on every use. NULL only for rows that predate this column.
ALTER TABLE plugin_installations ADD COLUMN manifest_sha256 text;

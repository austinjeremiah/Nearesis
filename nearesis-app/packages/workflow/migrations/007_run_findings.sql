SET LOCAL search_path = runtime;

-- Interpretation stage (final_master_prompt s10/s20): the grounded findings an analyst wrote from the run's panel results,
-- with the skeptic's notes. One row per finding; `finding` is the InterpretedFinding (contracts), `position` its order.
-- `run_interpretation` records the run-level outcome (ready / unavailable / none) so "interpretation unavailable" is
-- visible and distinct from "no findings yet".
CREATE TABLE IF NOT EXISTS run_findings (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  run_id        uuid NOT NULL,
  position      int  NOT NULL,
  finding       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, position)
);
CREATE INDEX IF NOT EXISTS run_findings_run_idx ON run_findings (run_id, position);

CREATE TABLE IF NOT EXISTS run_interpretation (
  run_id        uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  state         text NOT NULL CHECK (state IN ('ready','unavailable','none')),
  reason        text,
  finding_count int  NOT NULL DEFAULT 0,
  rejected      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['run_findings','run_interpretation']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nearesis_app', t);
  END LOOP;
END $$;

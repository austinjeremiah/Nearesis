-- Kernel-side approval records (ch.05: the kernel verifies approvals at execution time) and in-flight invocation deadlines.

CREATE TABLE command_approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  run_id uuid NOT NULL,
  action_hash text NOT NULL,
  approved_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  used_by text,
  UNIQUE (workspace_id, run_id, action_hash)
);
CREATE INDEX command_approvals_run_idx ON command_approvals(workspace_id, run_id);

ALTER TABLE command_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE command_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON command_approvals
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT, INSERT, UPDATE ON command_approvals TO nearesis_app;

-- A `running` invocation becomes claimable after deadline_at (one CAS), see gateway takeover.
ALTER TABLE tool_invocations ADD COLUMN deadline_at timestamptz;
ALTER TABLE tool_invocations ADD COLUMN takeover_count integer NOT NULL DEFAULT 0;

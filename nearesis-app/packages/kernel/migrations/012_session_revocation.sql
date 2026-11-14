-- Session revocation (ch.12 access revocation): a revoked token id is refused by the kernel auth path on the next request.
CREATE TABLE revoked_sessions (
  jti text PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT 'logout'
);
CREATE INDEX revoked_sessions_user_idx ON revoked_sessions(org_id, user_id);
ALTER TABLE revoked_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revoked_sessions
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT, INSERT ON revoked_sessions TO nearesis_app;

-- Approvals can be revoked before use; a revoked approval is refused at execution time.
ALTER TABLE command_approvals ADD COLUMN revoked_at timestamptz;

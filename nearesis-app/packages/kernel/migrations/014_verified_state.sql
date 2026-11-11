-- Verification state (SEC14): the only writer is a verifier-originated result. The application role has SELECT only; the
-- SECURITY DEFINER function below is the single write path and it refuses every caller that is not a registered verifier
-- service identity. Rows carry a keyed hash (HMAC, key held by the kernel process, never by the database), so a hand-edited
-- row is detected at publication.

-- Verifier service identities are provisioned by an operator with database admin rights; the application cannot add one.
CREATE TABLE verifier_identities (
  actor_id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON verifier_identities TO nearesis_app;

CREATE TABLE verification_states (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('capsule','inference_response','evidence_item')),
  subject_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('verified','unverified','failed')),
  reason text,
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  verifier_id uuid NOT NULL REFERENCES verifier_identities(actor_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  row_hmac text NOT NULL CHECK (row_hmac ~ '^[0-9a-f]{64}$')
);
CREATE INDEX verification_states_subject_idx ON verification_states(workspace_id, subject_kind, subject_ref, created_at);
ALTER TABLE verification_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verification_states
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT ON verification_states TO nearesis_app;

CREATE FUNCTION verified_state_record(
  p_id uuid, p_org uuid, p_workspace uuid, p_kind text, p_ref text, p_state text, p_reason text,
  p_response text, p_hmac text, p_created timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_actor_kind() <> 'service' OR app_org_id() IS DISTINCT FROM p_org
     OR NOT EXISTS (SELECT 1 FROM verifier_identities v WHERE v.actor_id = app_user_id()) THEN
    RAISE EXCEPTION 'permission denied: only a verifier identity may write verification state' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = p_workspace AND w.org_id = p_org) THEN
    RAISE EXCEPTION 'permission denied: workspace outside the verifier tenant' USING ERRCODE = '42501';
  END IF;
  INSERT INTO verification_states(id, org_id, workspace_id, subject_kind, subject_ref, state, reason, response_sha256,
                                  verifier_id, created_at, row_hmac)
  VALUES (p_id, p_org, p_workspace, p_kind, p_ref, p_state, p_reason, p_response, app_user_id(), p_created, p_hmac);
END $$;
REVOKE ALL ON FUNCTION verified_state_record(uuid, uuid, uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verified_state_record(uuid, uuid, uuid, text, text, text, text, text, text, timestamptz) TO nearesis_app;

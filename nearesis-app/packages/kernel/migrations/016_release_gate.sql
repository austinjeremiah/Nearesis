-- Security release gate (SEC22): waiver records and owner notifications.
-- Waivers are append-only and can only be written by the SECURITY DEFINER function, which accepts a human owner or admin
-- as signer, an independent second human owner or admin as reviewer, and never a critical or NO-GO finding.

CREATE TABLE release_waivers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  finding_id text NOT NULL CHECK (char_length(finding_id) BETWEEN 1 AND 200),
  finding_class text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  rationale text NOT NULL CHECK (char_length(rationale) BETWEEN 10 AND 2000),
  signer_id uuid NOT NULL,
  signer_kind text NOT NULL,
  reviewer_id uuid NOT NULL,
  independent_review_ref text NOT NULL CHECK (char_length(independent_review_ref) BETWEEN 3 AND 500),
  signed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (org_id, finding_id, signer_id)
);
ALTER TABLE release_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON release_waivers
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT ON release_waivers TO nearesis_app;

CREATE FUNCTION release_waiver_sign(
  p_id uuid, p_finding text, p_class text, p_severity text, p_rationale text, p_reviewer uuid, p_review_ref text,
  p_expires timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid := app_org_id(); v_signer uuid := app_user_id();
BEGIN
  IF app_actor_kind() <> 'human' THEN
    RAISE EXCEPTION 'permission denied: only a human may sign a waiver' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = v_org AND m.user_id = v_signer AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'permission denied: signer is not an authorised owner or admin' USING ERRCODE = '42501';
  END IF;
  IF p_reviewer = v_signer OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = v_org AND m.user_id = p_reviewer AND m.role IN ('owner','admin')) THEN
    RAISE EXCEPTION 'permission denied: the review must be independent and by an authorised human' USING ERRCODE = '42501';
  END IF;
  IF p_severity = 'critical' OR p_class <> 'other' THEN
    RAISE EXCEPTION 'check violation: a critical or NO-GO finding cannot be waived' USING ERRCODE = '23514';
  END IF;
  INSERT INTO release_waivers(id, org_id, finding_id, finding_class, severity, rationale, signer_id, signer_kind,
                              reviewer_id, independent_review_ref, expires_at)
  VALUES (p_id, v_org, p_finding, p_class, p_severity, p_rationale, v_signer, 'human', p_reviewer, p_review_ref, p_expires);
END $$;
REVOKE ALL ON FUNCTION release_waiver_sign(uuid, text, text, text, text, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_waiver_sign(uuid, text, text, text, text, uuid, text, timestamptz) TO nearesis_app;

CREATE TABLE owner_notifications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL,
  subject text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
ALTER TABLE owner_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON owner_notifications
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
GRANT SELECT, INSERT ON owner_notifications TO nearesis_app;

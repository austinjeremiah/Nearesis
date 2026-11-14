-- Product features that existed only as UI (frontend audit s4 items 6-9, 8): hypotheses with hashed freezes and amendments,
-- workspace profile and templates, pinning, invites, thesis documents. Every tenant table is RLS-forced on app_can_access_org.

-- ---------------------------------------------------------------------------------------------------------------- workspaces
ALTER TABLE workspaces ADD COLUMN name text CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 120);
ALTER TABLE workspaces ADD COLUMN description text CHECK (description IS NULL OR char_length(description) <= 2000);
ALTER TABLE workspaces ADD COLUMN template_id text CHECK (template_id IS NULL OR char_length(template_id) <= 120);

-- Org-defined templates. A template carries canvas CONFIG (layout mode, viewport, notes), never data or panel results.
CREATE TABLE workspace_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_-]{1,63}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  objective_hint text CHECK (objective_hint IS NULL OR char_length(objective_hint) <= 1000),
  canvas_config jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);

-- Pinning is per user.
CREATE TABLE workspace_pins (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);

-- ------------------------------------------------------------------------------------------------------------------ invites
-- Invites are org-level (membership is org-level in this model: a workspace is visible to every org member). `workspace_id`
-- only records which workspace the person was invited to look at. The token is HMAC-signed and carries its expiry; only the
-- sha256 of the token is stored.
CREATE TABLE org_invites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid REFERENCES workspaces(id),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  role text NOT NULL CHECK (role IN ('admin','analyst','viewer')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX org_invites_org_idx ON org_invites(org_id, created_at);

-- Platform-level HMAC key for invite tokens: never visible to the app role except through invite_secret().
CREATE TABLE platform_secrets (name text PRIMARY KEY, secret text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON platform_secrets FROM PUBLIC;
CREATE FUNCTION invite_secret() RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE s text;
BEGIN
  SELECT secret INTO s FROM platform_secrets WHERE name = 'invite_hmac';
  IF s IS NULL THEN
    INSERT INTO platform_secrets(name, secret)
      VALUES ('invite_hmac', replace(gen_random_uuid()::text || gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
      ON CONFLICT (name) DO NOTHING;
    SELECT secret INTO s FROM platform_secrets WHERE name = 'invite_hmac';
  END IF;
  RETURN s;
END $$;
REVOKE ALL ON FUNCTION invite_secret() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_secret() TO nearesis_app;

-- The invitee has no tenant context for the inviting org, so the two token-gated reads/writes are definer functions.
-- state: pending | expired | accepted | revoked
CREATE FUNCTION invite_lookup(p_token_hash text)
RETURNS TABLE(invite_id uuid, org_id uuid, org_name text, workspace_id uuid, role text, email text, expires_at timestamptz, state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.org_id, o.name, i.workspace_id, i.role, i.email, i.expires_at,
         CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
              WHEN i.revoked_at IS NOT NULL THEN 'revoked'
              WHEN i.expires_at <= now() THEN 'expired'
              ELSE 'pending' END
    FROM org_invites i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash = p_token_hash
$$;
REVOKE ALL ON FUNCTION invite_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_lookup(text) TO nearesis_app;

CREATE FUNCTION invite_accept(p_token_hash text, p_user_id uuid)
RETURNS TABLE(out_outcome text, out_org_id uuid, out_role text, out_workspace_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE i org_invites%ROWTYPE; st text;
BEGIN
  SELECT * INTO i FROM org_invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::text, NULL::uuid; RETURN; END IF;
  st := CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
             WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END;
  IF st <> 'pending' THEN RETURN QUERY SELECT st, i.org_id, i.role, i.workspace_id; RETURN; END IF;
  INSERT INTO memberships(org_id, user_id, role) VALUES (i.org_id, p_user_id, i.role) ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE org_invites SET accepted_at = now(), accepted_by = p_user_id WHERE id = i.id;
  RETURN QUERY SELECT 'accepted_now'::text, i.org_id, i.role, i.workspace_id;
END $$;
REVOKE ALL ON FUNCTION invite_accept(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invite_accept(text, uuid) TO nearesis_app;

GRANT DELETE ON memberships TO nearesis_app;

-- ------------------------------------------------------------------------------------------------------------- hypotheses
-- One row per VERSION. A version is `draft` until frozen; a frozen row is never changed again (trigger below). An amendment is
-- a new row (same root_id, version + 1, parent_id = the frozen version it amends). A fork starts a new root.
CREATE TABLE hypotheses (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  root_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  parent_id uuid REFERENCES hypotheses(id),
  forked_from_id uuid REFERENCES hypotheses(id),
  proposition text NOT NULL CHECK (char_length(btrim(proposition)) BETWEEN 5 AND 4000),
  target text NOT NULL CHECK (char_length(target) <= 2000),
  predictor text NOT NULL CHECK (char_length(predictor) <= 2000),
  benchmark text NOT NULL CHECK (char_length(benchmark) <= 2000),
  falsification text NOT NULL CHECK (char_length(falsification) <= 4000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','frozen')),
  freeze_hash text,
  frozen_at timestamptz,
  frozen_by uuid REFERENCES users(id),
  -- {hash, source, verified, note}: link to a preregistration document hash; never claims a chain commitment.
  preregistration jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, version),
  CHECK (status = 'draft' OR (freeze_hash IS NOT NULL AND frozen_at IS NOT NULL AND frozen_by IS NOT NULL)),
  CHECK (freeze_hash IS NULL OR freeze_hash ~ '^sha256:[0-9a-f]{64}$')
);
CREATE INDEX hypotheses_ws_idx ON hypotheses(workspace_id, created_at);
CREATE UNIQUE INDEX hypotheses_one_draft_per_root ON hypotheses(root_id) WHERE status = 'draft';

CREATE FUNCTION hypotheses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'frozen' THEN
      RAISE EXCEPTION 'frozen hypothesis is immutable' USING ERRCODE = 'P0001', HINT = 'HYPOTHESIS_FROZEN';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'frozen' THEN
    RAISE EXCEPTION 'frozen hypothesis is immutable' USING ERRCODE = 'P0001', HINT = 'HYPOTHESIS_FROZEN';
  END IF;
  -- identity never changes, even on drafts
  IF NEW.id <> OLD.id OR NEW.root_id <> OLD.root_id OR NEW.version <> OLD.version OR NEW.org_id <> OLD.org_id
     OR NEW.workspace_id <> OLD.workspace_id OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.forked_from_id IS DISTINCT FROM OLD.forked_from_id THEN
    RAISE EXCEPTION 'hypothesis identity is immutable' USING ERRCODE = 'P0001', HINT = 'HYPOTHESIS_IDENTITY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hypotheses_guard BEFORE UPDATE OR DELETE ON hypotheses FOR EACH ROW EXECUTE FUNCTION hypotheses_guard();

-- Evidence links, append-only: kind claim -> evidence_nodes.id, experiment -> research run id, finding -> runtime run_findings id.
CREATE TABLE hypothesis_links (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  root_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('claim','experiment','finding')),
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (root_id, kind, ref)
);
CREATE INDEX hypothesis_links_ws_idx ON hypothesis_links(workspace_id, root_id);

-- --------------------------------------------------------------------------------------------------------- thesis documents
CREATE TABLE thesis_documents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Versions are immutable (insert-only for the app role): a re-assembly is a new version with its own digest.
CREATE TABLE thesis_versions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  document_id uuid NOT NULL REFERENCES thesis_documents(id),
  version integer NOT NULL CHECK (version >= 1),
  content jsonb NOT NULL,
  markdown text NOT NULL,
  content_digest text NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  validation jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('validated','blocked')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_templates','workspace_pins','org_invites','hypotheses','hypothesis_links','thesis_documents','thesis_versions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id))', t);
  END LOOP;
END $$;
-- Pins are visible and writable only to their owner.
DROP POLICY tenant_isolation ON workspace_pins;
CREATE POLICY pin_owner ON workspace_pins USING (app_can_access_org(org_id) AND user_id = app_user_id())
  WITH CHECK (app_can_access_org(org_id) AND user_id = app_user_id());

GRANT SELECT, INSERT, DELETE ON workspace_templates, workspace_pins TO nearesis_app;
GRANT SELECT, INSERT, UPDATE ON org_invites TO nearesis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON hypotheses TO nearesis_app;
GRANT SELECT, INSERT ON hypothesis_links, thesis_documents, thesis_versions TO nearesis_app;

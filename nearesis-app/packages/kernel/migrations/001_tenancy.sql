-- Tenancy core: organizations, users, memberships, workspaces, branches. RLS keyed on app.org_id / app.user_id.

CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
-- Server-set only (never from clients): 'human' | 'agent' | 'service'.
CREATE FUNCTION app_actor_kind() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('app.actor_kind', true), ''), 'human') $$;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  policy_version integer NOT NULL DEFAULT 1
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  oidc_subject text NOT NULL UNIQUE,
  display_name text
);

CREATE TABLE memberships (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','analyst','viewer')),
  PRIMARY KEY (org_id, user_id)
);

-- Workspace access = org matches the session org AND (the user has a membership, or the caller is a server-side
-- agent/service principal whose authority is further narrowed by capability leases).
CREATE FUNCTION app_can_access_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT p_org = app_org_id() AND (
    app_actor_kind() IN ('agent','service')
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = p_org AND m.user_id = app_user_id())
  )
$$;

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  objective text NOT NULL,
  network_scope text NOT NULL CHECK (network_scope IN ('near-mainnet-read','near-testnet','fixture-only')),
  active_branch_id uuid,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX workspaces_org_idx ON workspaces(org_id);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  parent_branch_id uuid,
  base_event_seq integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL REFERENCES users(id),
  merge_policy text NOT NULL DEFAULT 'human_accept'
);

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;  ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;          ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;    ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;     ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;       ALTER TABLE branches FORCE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON organizations USING (id = app_org_id()) WITH CHECK (id = app_org_id());
CREATE POLICY membership_isolation ON memberships USING (org_id = app_org_id()) WITH CHECK (org_id = app_org_id());
CREATE POLICY user_visibility ON users
  USING (id = app_user_id() OR id IN (SELECT user_id FROM memberships WHERE org_id = app_org_id()))
  WITH CHECK (id = app_user_id());
CREATE POLICY workspace_isolation ON workspaces
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));
CREATE POLICY branch_isolation ON branches
  USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));

-- Login happens before any tenant context exists. This definer function (owned by the migrating superuser) is the only
-- unscoped read of identity data: subject -> (user, org, role). It returns at most one row.
CREATE FUNCTION auth_resolve_subject(p_subject text)
RETURNS TABLE(user_id uuid, org_id uuid, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.id, m.org_id, m.role FROM users u JOIN memberships m ON m.user_id = u.id
  WHERE u.oidc_subject = p_subject ORDER BY m.org_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION auth_resolve_subject(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_subject(text) TO nearesis_app;

GRANT SELECT, INSERT, UPDATE ON organizations, users, memberships, workspaces, branches TO nearesis_app;

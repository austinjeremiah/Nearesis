-- NEAR wallet sign-in (NEP-413): the linked account on a user and single-use sign-in challenges.
ALTER TABLE users ADD COLUMN near_account_id text UNIQUE;

-- Challenges exist before any tenant context, so the table is not row-level secured; it holds no identity data.
CREATE TABLE near_auth_challenges (
  id uuid PRIMARY KEY,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 32),
  message text NOT NULL,
  recipient text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX near_auth_challenges_expires_idx ON near_auth_challenges(expires_at);
GRANT SELECT, INSERT, UPDATE ON near_auth_challenges TO nearesis_app;

-- Sign-in happens before a tenant context exists, and creating a user, its personal organisation and the owner membership
-- crosses the row-level policies. This definer function is the only such write: find the user by NEAR account, or provision
-- one (user, organisation named after the account, owner membership, and a zero credit account when that table exists).
CREATE FUNCTION near_auth_provision(p_account text)
RETURNS TABLE(user_id uuid, org_id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid;
  v_org uuid;
  v_created boolean := false;
BEGIN
  SELECT u.id INTO v_user FROM users u WHERE u.near_account_id = p_account;
  IF v_user IS NULL THEN
    BEGIN
      v_user := gen_random_uuid();
      v_org := gen_random_uuid();
      INSERT INTO users(id, oidc_subject, display_name, near_account_id)
        VALUES (v_user, 'near:' || p_account, p_account, p_account);
      INSERT INTO organizations(id, name) VALUES (v_org, p_account);
      INSERT INTO memberships(org_id, user_id, role) VALUES (v_org, v_user, 'owner');
      v_created := true;
    EXCEPTION WHEN unique_violation THEN
      -- a concurrent sign-in created the same account first; the subtransaction rolled back, use theirs
      SELECT u.id INTO v_user FROM users u WHERE u.near_account_id = p_account;
      IF v_user IS NULL THEN RAISE; END IF;
      v_created := false;
    END;
  END IF;
  SELECT m.org_id INTO v_org FROM memberships m WHERE m.user_id = v_user ORDER BY m.org_id LIMIT 1;
  IF v_org IS NULL THEN RAISE EXCEPTION 'near account % has no membership', p_account; END IF;
  IF to_regclass('public.credit_accounts') IS NOT NULL THEN
    EXECUTE 'INSERT INTO credit_accounts(user_id, balance_yocto, held_yocto) VALUES ($1, 0, 0) ON CONFLICT DO NOTHING'
      USING v_user;
  END IF;
  RETURN QUERY SELECT v_user, v_org, v_created;
END $$;
REVOKE ALL ON FUNCTION near_auth_provision(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION near_auth_provision(text) TO nearesis_app;

-- User theses: a deterministic `nearesis.thesis.v1` document built from a workspace run and its capsule, shareable by a
-- public link, importable into other accounts, with receipts of every verification and reproduction.
-- Visibility: members of the owning organisation (app_can_access_org) and users who imported the thesis. A published thesis
-- is also readable WITHOUT a session, but only through the definer functions below (no ids beyond the document leave them).
CREATE TABLE theses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  run_id uuid NOT NULL,
  capsule_id text NOT NULL,
  -- hash-derived id of the inputs (`v-` + 12 hex); one thesis per (workspace, run, version)
  version text NOT NULL CHECK (version ~ '^v-[0-9a-f]{12}$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','unpublished')),
  share_slug text UNIQUE CHECK (share_slug IS NULL OR share_slug ~ '^[a-z0-9]{12,40}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  doc jsonb NOT NULL,
  doc_sha256 text NOT NULL CHECK (doc_sha256 ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL DEFAULT 'workspace' CHECK (kind IN ('workspace','reproduction')),
  -- the thesis this one reproduces (kind = reproduction)
  source_thesis_id uuid REFERENCES theses(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (workspace_id, run_id, version),
  CHECK ((kind = 'reproduction') = (source_thesis_id IS NOT NULL)),
  CHECK (status = 'draft' OR share_slug IS NOT NULL)
);
CREATE INDEX theses_org_idx ON theses(org_id, created_at DESC);
CREATE INDEX theses_workspace_idx ON theses(workspace_id, created_at DESC);

CREATE TABLE thesis_imports (
  user_id uuid NOT NULL REFERENCES users(id),
  thesis_id uuid NOT NULL REFERENCES theses(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, thesis_id)
);

-- thesis_id is a thesis uuid, or the pinned reference thesis key (which has no row in `theses`).
CREATE TABLE thesis_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id text NOT NULL CHECK (thesis_id = 'reference-near-intents' OR thesis_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  user_id uuid REFERENCES users(id),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  kind text NOT NULL CHECK (kind IN ('verify','reproduce')),
  outcome text NOT NULL CHECK (outcome IN ('verified','mismatch','match','drift','different')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thesis_receipts_thesis_idx ON thesis_receipts(thesis_id, created_at DESC);

ALTER TABLE theses ENABLE ROW LEVEL SECURITY;          ALTER TABLE theses FORCE ROW LEVEL SECURITY;
ALTER TABLE thesis_imports ENABLE ROW LEVEL SECURITY;  ALTER TABLE thesis_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE thesis_receipts ENABLE ROW LEVEL SECURITY; ALTER TABLE thesis_receipts FORCE ROW LEVEL SECURITY;

-- Definer helper: is the thesis published (used by the import policy; the importer has no tenant context for the owner org).
CREATE FUNCTION thesis_is_published(p_thesis uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM theses t WHERE t.id = p_thesis AND t.status = 'published')
$$;
REVOKE ALL ON FUNCTION thesis_is_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_is_published(uuid) TO nearesis_app;

-- Importer visibility without recursion: thesis_imports is keyed on the user only.
CREATE POLICY thesis_read ON theses FOR SELECT
  USING (app_can_access_org(org_id)
         OR EXISTS (SELECT 1 FROM thesis_imports i WHERE i.thesis_id = theses.id AND i.user_id = app_user_id()));
CREATE POLICY thesis_insert ON theses FOR INSERT WITH CHECK (app_can_access_org(org_id));
CREATE POLICY thesis_update ON theses FOR UPDATE USING (app_can_access_org(org_id)) WITH CHECK (app_can_access_org(org_id));

CREATE POLICY thesis_import_owner_read ON thesis_imports FOR SELECT USING (user_id = app_user_id());
CREATE POLICY thesis_import_owner_write ON thesis_imports FOR INSERT
  WITH CHECK (user_id = app_user_id() AND thesis_is_published(thesis_id));

-- Receipts are visible where the thesis is visible (theses RLS applies inside the subquery); the reference thesis is visible to all.
CREATE POLICY thesis_receipt_read ON thesis_receipts FOR SELECT
  USING (thesis_id = 'reference-near-intents' OR EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_receipts.thesis_id));
CREATE POLICY thesis_receipt_write ON thesis_receipts FOR INSERT
  WITH CHECK (user_id = app_user_id()
              AND (thesis_id = 'reference-near-intents' OR EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_receipts.thesis_id)));

-- Public (no session) reads. Only published theses; the row carries a display name, never an org, workspace or user id.
CREATE FUNCTION thesis_public_get(p_slug text)
RETURNS TABLE(id uuid, version text, title text, doc jsonb, doc_sha256 text, kind text, capsule_id text, published_at timestamptz, owner_display text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.version, t.title, t.doc, t.doc_sha256, t.kind, t.capsule_id, t.published_at, u.display_name
    FROM theses t JOIN users u ON u.id = t.owner_user_id
   WHERE t.share_slug = p_slug AND t.status = 'published'
$$;
REVOKE ALL ON FUNCTION thesis_public_get(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_public_get(text) TO nearesis_app;

CREATE FUNCTION thesis_receipt_counts(p_thesis text)
RETURNS TABLE(verified int, reproduced int, drift int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE kind = 'verify' AND outcome = 'verified')::int,
         count(*) FILTER (WHERE kind = 'reproduce' AND outcome IN ('match','drift'))::int,
         count(*) FILTER (WHERE (kind = 'verify' AND outcome = 'mismatch') OR (kind = 'reproduce' AND outcome = 'drift'))::int
    FROM thesis_receipts WHERE thesis_id = p_thesis
$$;
REVOKE ALL ON FUNCTION thesis_receipt_counts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_receipt_counts(text) TO nearesis_app;

-- OutLayer proof binding of a capsule behind a PUBLISHED thesis, for a verifier outside the owning organisation.
CREATE FUNCTION thesis_proof_binding(p_capsule text)
RETURNS TABLE(state text, request_id text, tx_hash text, input_sha256 text, output_sha256 text, decision text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p.state, p.request_id, p.tx_hash, p.input_sha256, p.output_sha256, p.decision
    FROM outlayer_proofs p
   WHERE p.capsule_id = p_capsule
     AND EXISTS (SELECT 1 FROM theses t WHERE t.capsule_id = p_capsule AND t.status = 'published')
   ORDER BY (p.state = 'verified') DESC, p.created_at DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION thesis_proof_binding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_proof_binding(text) TO nearesis_app;

GRANT SELECT, INSERT, UPDATE ON theses TO nearesis_app;
GRANT SELECT, INSERT ON thesis_imports, thesis_receipts TO nearesis_app;

-- Thesis challenges: one skeptic model call over a thesis, stored beside it, never touching the thesis document or its hash.
-- thesis_id is a thesis uuid, or the pinned reference thesis key (which has no row in `theses`), exactly like thesis_receipts.
-- Visibility follows the thesis (theses RLS applies inside the subquery); a PUBLISHED thesis shows its challenges to a reader
-- without a session only through the definer functions below. Only the thesis owner organisation can answer (column-level UPDATE).
CREATE TABLE thesis_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id text NOT NULL CHECK (thesis_id = 'reference-near-intents' OR thesis_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  user_id uuid REFERENCES users(id),
  display_name text CHECK (display_name IS NULL OR char_length(display_name) <= 120),
  outcome text NOT NULL CHECK (outcome IN ('holds','weakened','unsupported','unavailable')),
  -- the notes that passed validation: [{ text, group, severity, refs }]
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  dropped_notes int NOT NULL DEFAULT 0 CHECK (dropped_notes >= 0),
  cost_usd_micro bigint NOT NULL DEFAULT 0 CHECK (cost_usd_micro >= 0),
  model_calls int NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  answer text CHECK (answer IS NULL OR char_length(answer) BETWEEN 1 AND 600),
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX thesis_challenges_thesis_idx ON thesis_challenges(thesis_id, created_at DESC);

ALTER TABLE thesis_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE thesis_challenges FORCE ROW LEVEL SECURITY;

CREATE POLICY thesis_challenge_read ON thesis_challenges FOR SELECT
  USING (thesis_id = 'reference-near-intents' OR EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_challenges.thesis_id));
CREATE POLICY thesis_challenge_write ON thesis_challenges FOR INSERT
  WITH CHECK (user_id = app_user_id()
              AND (thesis_id = 'reference-near-intents' OR EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_challenges.thesis_id)));
-- answering: members of the thesis' owning organisation only (the API also requires the editor role)
CREATE POLICY thesis_challenge_answer ON thesis_challenges FOR UPDATE
  USING (EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_challenges.thesis_id AND app_can_access_org(t.org_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM theses t WHERE t.id::text = thesis_challenges.thesis_id AND app_can_access_org(t.org_id)));

-- Public (no session) reads: only challenges of a published thesis; never a user id.
CREATE FUNCTION thesis_challenges_public(p_thesis uuid)
RETURNS TABLE(id uuid, outcome text, notes jsonb, dropped_notes int, cost_usd_micro bigint, model_calls int, answer text, answered_at timestamptz, created_at timestamptz, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.outcome, c.notes, c.dropped_notes, c.cost_usd_micro, c.model_calls, c.answer, c.answered_at, c.created_at, c.display_name
    FROM thesis_challenges c
   WHERE c.thesis_id = p_thesis::text
     AND EXISTS (SELECT 1 FROM theses t WHERE t.id = p_thesis AND t.status = 'published')
   ORDER BY c.created_at DESC, c.id LIMIT 10
$$;
REVOKE ALL ON FUNCTION thesis_challenges_public(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_challenges_public(uuid) TO nearesis_app;

-- Counts of finished challenges (an unavailable one produced nothing and is not counted), for the receipts counts object.
CREATE FUNCTION thesis_challenge_count(p_thesis text)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM thesis_challenges WHERE thesis_id = p_thesis AND outcome <> 'unavailable'
$$;
REVOKE ALL ON FUNCTION thesis_challenge_count(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_challenge_count(text) TO nearesis_app;

GRANT SELECT, INSERT ON thesis_challenges TO nearesis_app;
GRANT UPDATE (answer, answered_at) ON thesis_challenges TO nearesis_app;

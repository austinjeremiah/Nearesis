-- The test plan stored with a hypothesis: the two daily series (panel hash and column), the relation, the expected sign and the
-- plain testable sentence that a workspace thesis tests. Nullable: hypotheses written by hand and older drafts have none.
-- Additive; servers that do not read the column are unaffected, and a frozen version stays immutable (the plan is written with the draft).
ALTER TABLE hypotheses ADD COLUMN test_plan jsonb CHECK (test_plan IS NULL OR jsonb_typeof(test_plan) = 'object');

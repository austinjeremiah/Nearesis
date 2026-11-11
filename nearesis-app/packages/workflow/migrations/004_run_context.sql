SET LOCAL search_path = runtime;

-- BLOCKED_SOURCE: a fresh-data run refused or stopped because a source it reads is not healthy (contracts 1.5.0).
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_state_check;
ALTER TABLE runs ADD CONSTRAINT runs_state_check CHECK (state IN ('REQUESTED','PLANNING','APPROVAL_NEEDED','EXECUTING','EVIDENCE_REVIEW','CANVAS_PATCH_REVIEW','COMPLETE','PARTIAL','BLOCKED','BLOCKED_SOURCE','CANCELLED'));

-- The run's frozen dispatch context (question, snapshot, metric-version-map and preregistration hashes) and the copy
-- every child task was dispatched with (ch.16b B12). Both are written by the workflow's activities only.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS context jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS context jsonb;

-- Semantic layer the run's agents query: the SYNTHETIC fixture cubes (default) or the LIVE real-data layer (cube-live).
-- Chosen by the human on the question (contracts 1.4.0 `source`), read by the near-thesis plugin per invocation.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'fixture' CHECK (source IN ('fixture','live'));

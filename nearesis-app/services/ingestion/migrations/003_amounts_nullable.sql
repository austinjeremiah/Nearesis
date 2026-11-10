-- Empty-string amounts from the provider mean "unknown": stored as NULL, never 0.
ALTER TABLE ingestion.explorer_swaps ALTER COLUMN amount_in DROP NOT NULL;
ALTER TABLE ingestion.explorer_swaps ALTER COLUMN amount_out DROP NOT NULL;

-- Thesis reproduction by re-execution: a reproduce receipt can now also be "incomplete" (an input could not be re-executed),
-- and the receipt counts separate every outcome instead of folding verify mismatches into drift.
ALTER TABLE thesis_receipts DROP CONSTRAINT thesis_receipts_outcome_check;
ALTER TABLE thesis_receipts ADD CONSTRAINT thesis_receipts_outcome_check
  CHECK (outcome IN ('verified','mismatch','match','drift','different','incomplete'));

-- v2 keeps the old function untouched (servers started before this migration still call it).
CREATE FUNCTION thesis_receipt_counts_v2(p_thesis text)
RETURNS TABLE(verified int, reproduced int, drift int, different int, incomplete int, mismatch int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE kind = 'verify' AND outcome = 'verified')::int,
         count(*) FILTER (WHERE kind = 'reproduce' AND outcome = 'match')::int,
         count(*) FILTER (WHERE kind = 'reproduce' AND outcome = 'drift')::int,
         count(*) FILTER (WHERE kind = 'reproduce' AND outcome = 'different')::int,
         count(*) FILTER (WHERE kind = 'reproduce' AND outcome = 'incomplete')::int,
         count(*) FILTER (WHERE kind = 'verify' AND outcome = 'mismatch')::int
    FROM thesis_receipts WHERE thesis_id = p_thesis
$$;
REVOKE ALL ON FUNCTION thesis_receipt_counts_v2(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION thesis_receipt_counts_v2(text) TO nearesis_app;

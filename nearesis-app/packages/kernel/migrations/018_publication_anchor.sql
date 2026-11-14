-- Independent append-only publication record (signing-time anchoring). Every published manifest hash and its signer-asserted
-- signing time are appended with the DATABASE clock; a second entry per manifest records the NEAR testnet commitment.
-- The chain is built by the trigger, so a client cannot choose seq, prev_hash, entry_hash or anchored_at; rows can never be
-- updated, deleted or truncated. A key holder who backdates `signed_at` cannot backdate `anchored_at`.

CREATE TABLE publication_anchor_log (
  seq bigint PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('publish','chain-commit')),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  signed_at text NOT NULL DEFAULT '',
  payload text NOT NULL CHECK (char_length(payload) <= 4000),
  anchored_at timestamptz NOT NULL,
  prev_hash text NOT NULL,
  entry_hash text NOT NULL UNIQUE
);
CREATE INDEX publication_anchor_log_manifest ON publication_anchor_log (manifest_hash);

CREATE FUNCTION publication_anchor_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('publication_anchor_log'));
  SELECT seq, entry_hash INTO last_seq, last_hash FROM publication_anchor_log ORDER BY seq DESC LIMIT 1;
  NEW.seq := COALESCE(last_seq, 0) + 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.anchored_at := clock_timestamp();
  NEW.entry_hash := encode(sha256(convert_to(
    NEW.seq || '|' || NEW.kind || '|' || NEW.manifest_hash || '|' || NEW.signed_at || '|' ||
    to_char(NEW.anchored_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || NEW.payload || '|' || NEW.prev_hash,
    'UTF8')), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER publication_anchor_chain BEFORE INSERT ON publication_anchor_log
  FOR EACH ROW EXECUTE FUNCTION publication_anchor_chain();

CREATE FUNCTION publication_anchor_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'publication_anchor_log is append-only' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER publication_anchor_no_change BEFORE UPDATE OR DELETE ON publication_anchor_log
  FOR EACH ROW EXECUTE FUNCTION publication_anchor_immutable();
CREATE TRIGGER publication_anchor_no_truncate BEFORE TRUNCATE ON publication_anchor_log
  FOR EACH STATEMENT EXECUTE FUNCTION publication_anchor_immutable();

GRANT SELECT, INSERT ON publication_anchor_log TO nearesis_app;

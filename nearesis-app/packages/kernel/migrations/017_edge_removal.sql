-- Merge acceptance may remove an evidence edge. The application role has no DELETE on evidence_edges (append-only
-- history), so a removal is recorded on the row: who removed it, when and why. Reads exclude removed edges; adding the
-- same relation again revives the row.
ALTER TABLE evidence_edges
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid,
  ADD COLUMN removed_reason text;

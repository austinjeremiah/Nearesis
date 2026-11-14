-- Per-user notification read state. A notification is shared by the workspace; whether it is read is a property of the
-- reader, so one member marking it read never hides it from the others. The legacy notifications.read_at/read_by columns
-- stay: a legacy read counts as read for the user recorded in read_by (and for everyone when read_by is NULL, i.e. a system read).
CREATE TABLE notification_reads (
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  notification_id uuid NOT NULL REFERENCES notifications(id),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notification_id)
);
CREATE INDEX notification_reads_notification_idx ON notification_reads(notification_id);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY read_owner ON notification_reads
  USING (app_can_access_org(org_id) AND user_id = app_user_id())
  WITH CHECK (app_can_access_org(org_id) AND user_id = app_user_id());
GRANT SELECT, INSERT ON notification_reads TO nearesis_app;

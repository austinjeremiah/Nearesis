-- Governed metric authoring (final_master_prompt section 4). Lifecycle DRAFT -> VALIDATED -> CERTIFIED -> DEPRECATED.
-- A certified version is immutable: its definition can never change, only be superseded or deprecated.

CREATE TABLE analytics_meta.authored_metrics (
  tenant_id        text        NOT NULL,
  workspace_id     text        NOT NULL,
  metric_key       text        NOT NULL,
  version          integer     NOT NULL CHECK (version > 0),
  status           text        NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'CERTIFIED', 'DEPRECATED')),
  proposal         jsonb       NOT NULL,
  proposal_hash    text        NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  validation       jsonb,
  author_id        text        NOT NULL,
  author_kind      text        NOT NULL CHECK (author_kind IN ('human', 'agent', 'service')),
  certified_ever   boolean     NOT NULL DEFAULT false,
  certified_by     text,
  certified_at     timestamptz,
  deprecated_by    text,
  deprecated_at    timestamptz,
  deprecation_reason text,
  superseded_by    integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, metric_key, version)
);
CREATE INDEX authored_metrics_status ON analytics_meta.authored_metrics (tenant_id, workspace_id, status);

CREATE FUNCTION analytics_meta.authored_metrics_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.certified_ever THEN
      RAISE EXCEPTION 'IMMUTABLE_VERSION: a certified metric version cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.metric_key <> OLD.metric_key
     OR NEW.version <> OLD.version OR NEW.author_id <> OLD.author_id OR NEW.author_kind <> OLD.author_kind THEN
    RAISE EXCEPTION 'IMMUTABLE_VERSION: identity and author of a metric version never change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.certified_ever AND (NEW.proposal IS DISTINCT FROM OLD.proposal OR NEW.proposal_hash <> OLD.proposal_hash
     OR NEW.certified_by IS DISTINCT FROM OLD.certified_by OR NEW.certified_at IS DISTINCT FROM OLD.certified_at
     OR NEW.certified_ever IS DISTINCT FROM OLD.certified_ever) THEN
    RAISE EXCEPTION 'IMMUTABLE_VERSION: a certified metric version cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT'     AND NEW.status IN ('VALIDATED', 'DEPRECATED'))
    OR (OLD.status = 'VALIDATED' AND NEW.status IN ('DRAFT', 'CERTIFIED', 'DEPRECATED'))
    OR (OLD.status = 'CERTIFIED' AND NEW.status = 'DEPRECATED')) THEN
    RAISE EXCEPTION 'ILLEGAL_TRANSITION: % -> %', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'CERTIFIED' AND OLD.status <> 'CERTIFIED' AND
     (NEW.certified_by IS NULL OR NEW.certified_at IS NULL OR NEW.validation IS NULL) THEN
    RAISE EXCEPTION 'ILLEGAL_TRANSITION: certification needs a certifier and a validation report' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER authored_metrics_guard BEFORE UPDATE OR DELETE ON analytics_meta.authored_metrics
  FOR EACH ROW EXECUTE FUNCTION analytics_meta.authored_metrics_guard();

-- Append-only audit of every lifecycle action, including refused ones.
CREATE TABLE analytics_meta.authored_metric_audit (
  id           bigserial   PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  tenant_id    text        NOT NULL,
  workspace_id text        NOT NULL,
  metric_key   text        NOT NULL,
  version      integer,
  action       text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('ok', 'refused')),
  actor_id     text        NOT NULL,
  actor_kind   text        NOT NULL,
  actor_role   text,
  detail       jsonb       NOT NULL DEFAULT '{}'
);
CREATE INDEX authored_metric_audit_key ON analytics_meta.authored_metric_audit (tenant_id, workspace_id, metric_key, id);

-- A snapshot pins the exact certified version it used. Pins are never updated: a later definition change cannot rewrite them.
CREATE TABLE analytics_meta.authored_metric_pins (
  tenant_id     text        NOT NULL,
  workspace_id  text        NOT NULL,
  snapshot_id   text        NOT NULL,
  metric_key    text        NOT NULL,
  version       integer     NOT NULL,
  proposal_hash text        NOT NULL,
  pinned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, snapshot_id, metric_key),
  FOREIGN KEY (tenant_id, workspace_id, metric_key, version)
    REFERENCES analytics_meta.authored_metrics (tenant_id, workspace_id, metric_key, version)
);

-- V18 correction flow: a deprecation by correction records which dependents (snapshots, metrics) are invalidated.
-- The dependents themselves are not rewritten; consumers read these rows to mark findings as needing re-derivation.
CREATE TABLE analytics_meta.authored_metric_corrections (
  id           bigserial   PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  tenant_id    text        NOT NULL,
  workspace_id text        NOT NULL,
  metric_key   text        NOT NULL,
  version      integer     NOT NULL,
  dependent_kind text      NOT NULL CHECK (dependent_kind IN ('snapshot', 'metric')),
  dependent_id text        NOT NULL,
  reason       text        NOT NULL,
  actor_id     text        NOT NULL
);

CREATE FUNCTION analytics_meta.authored_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER authored_metric_audit_ro BEFORE UPDATE OR DELETE ON analytics_meta.authored_metric_audit
  FOR EACH ROW EXECUTE FUNCTION analytics_meta.authored_append_only();
CREATE TRIGGER authored_metric_pins_ro BEFORE UPDATE OR DELETE ON analytics_meta.authored_metric_pins
  FOR EACH ROW EXECUTE FUNCTION analytics_meta.authored_append_only();
CREATE TRIGGER authored_metric_corrections_ro BEFORE UPDATE OR DELETE ON analytics_meta.authored_metric_corrections
  FOR EACH ROW EXECUTE FUNCTION analytics_meta.authored_append_only();

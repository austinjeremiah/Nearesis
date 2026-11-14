-- The human who requested the run. Capability leases are issued, and the approved canvas command is attributed, on
-- their behalf; the runtime never invents an identity (ch.04: agents propose, the kernel authorizes).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS requested_by uuid;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS requested_role text;

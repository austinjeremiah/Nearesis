-- The test plan of an agent task (the claim, written before the data is seen) and the one-line "why" of each step.
-- Additive: servers that do not read the columns are unaffected. A plan with a lock time is immutable.
ALTER TABLE agent_tasks ADD COLUMN test_plan jsonb CHECK (test_plan IS NULL OR jsonb_typeof(test_plan) = 'object');
ALTER TABLE agent_task_steps ADD COLUMN why text CHECK (why IS NULL OR char_length(why) <= 220);

CREATE FUNCTION agent_task_test_plan_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.test_plan IS NOT NULL AND OLD.test_plan->>'lockedAt' IS NOT NULL
     AND NEW.test_plan IS DISTINCT FROM OLD.test_plan THEN
    RAISE EXCEPTION 'the test plan of this task is locked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_task_test_plan_locked BEFORE UPDATE OF test_plan ON agent_tasks
  FOR EACH ROW EXECUTE FUNCTION agent_task_test_plan_locked();

-- ============================================================================
-- 485_onboarding_operator.sql  (Issue #15, Ed 2026-10-03)  -- PROPOSAL, NOT APPLIED
-- ----------------------------------------------------------------------------
-- AI-operated onboarding: the onboarding operator (actor_kind 'system') runs the
-- gated engine and continues automatically through ROUTINE PASS stages, so Ed is
-- not asked to click "advance" merely because an internal stage passed.
--
-- What changes (nothing else):
--   - onboarding_stage_events.onboarding_events_human_gates: a stage_advanced
--     event may also be recorded by actor_kind 'system'. Waivers and preflight
--     approvals remain HUMAN ONLY.
--   - onboarding_stage_events_validate: a system advance is refused unless the
--     result it relies on is a plain PASS (never a waived FAIL / BLOCKED) and the
--     target is a routine stage (normalize, source_controls, snapshot,
--     activity_bridge, preflight); never execute or beyond.
--   - conversion_batches_onboarding_guard: re-proves the same at the moment the
--     stage changes; execute still needs a HUMAN advance with a human-approved
--     preflight.
--   - onboarding_auto_advance(batch, completion, operator id): the operator's
--     single advance path (system only; PASS only).
-- Everything else (append-only events, completion binding, stale-result
-- protection, owner-only waivers, approvals, EXECUTE) is unchanged.
-- Requires 484. No rows change. service_role only.
-- ============================================================================
BEGIN;

ALTER TABLE onboarding_stage_events DROP CONSTRAINT IF EXISTS onboarding_events_human_gates;
ALTER TABLE onboarding_stage_events ADD CONSTRAINT onboarding_events_human_gates
  CHECK (event_type = 'stage_completed' OR actor_kind = 'human' OR (event_type = 'stage_advanced' AND actor_kind = 'system'));

-- Same as 481, plus: an operator (system) advance only on a PASS result into routine stages.
CREATE OR REPLACE FUNCTION onboarding_stage_events_validate() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE cur TEXT; c onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  SELECT onboarding_stage INTO cur FROM conversion_batches WHERE id = NEW.batch_id;
  IF cur IS NULL OR cur <> NEW.stage THEN
    RAISE EXCEPTION 'event for stage % but the batch is in %', NEW.stage, coalesce(cur, '(not enrolled)') USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_type = 'stage_completed' THEN RETURN NEW; END IF;
  SELECT * INTO c FROM onboarding_stage_events WHERE id = NEW.completion_event_id;
  IF NOT FOUND OR c.event_type <> 'stage_completed' OR c.batch_id <> NEW.batch_id OR c.stage <> NEW.stage THEN
    RAISE EXCEPTION 'event must reference a completion of this batch and stage' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM onboarding_stage_events l WHERE l.batch_id = c.batch_id AND l.stage = c.stage AND l.event_type = 'stage_completed' AND l.seq > c.seq) THEN
    RAISE EXCEPTION 'completion is stale: a newer result was recorded for stage %', c.stage USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.event_type = 'control_waived' THEN
    IF NOT (c.result->'open_controls') ? NEW.control_code THEN
      RAISE EXCEPTION '% is not an open control of that result', NEW.control_code USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM onboarding_stage_events w WHERE w.completion_event_id = c.id AND w.event_type = 'control_waived' AND w.control_code = NEW.control_code) THEN
      RAISE EXCEPTION '% is already waived for that result', NEW.control_code USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'stage_advanced' THEN
    IF NEW.to_stage IS DISTINCT FROM onboarding_next_stage(NEW.stage) THEN
      RAISE EXCEPTION 'stage % may only advance to %', NEW.stage, onboarding_next_stage(NEW.stage) USING ERRCODE = 'check_violation';
    END IF;
    why := onboarding_completion_gate(c.id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'advance refused: %', why USING ERRCODE = 'check_violation'; END IF;
    -- The operator (actor_kind 'system') may advance ONLY on a plain PASS result (never a
    -- waived FAIL/BLOCKED) and only into routine stages; never into execute or beyond.
    IF NEW.actor_kind = 'system' AND (c.result->>'status' IS DISTINCT FROM 'PASS' OR NEW.to_stage NOT IN ('normalize','source_controls','snapshot','activity_bridge','preflight')) THEN
      RAISE EXCEPTION 'operator advance refused: only a PASS result may advance automatically, and never into %', NEW.to_stage USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'preflight_approved' THEN
    why := onboarding_completion_gate(c.id);
    IF why IS NOT NULL THEN RAISE EXCEPTION 'approval refused: %', why USING ERRCODE = 'check_violation'; END IF;
  END IF;
  RETURN NEW;
END;
$fn$;

-- Same as 481, plus: an operator (system) advance counts only when its result is a plain PASS and never into execute.
CREATE OR REPLACE FUNCTION conversion_batches_onboarding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE adv onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  -- The approved preflight hash is set once, in preflight, from a human approval
  -- bound to the CURRENT (latest) preflight result.
  IF NEW.approved_preflight_sha256 IS DISTINCT FROM OLD.approved_preflight_sha256 THEN
    IF OLD.approved_preflight_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'approved preflight hash is write-once' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.onboarding_stage IS DISTINCT FROM 'preflight' OR NOT EXISTS (
      SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved'
        AND e.actor_kind = 'human' AND e.preflight_sha256 = NEW.approved_preflight_sha256
        AND onboarding_completion_gate(e.completion_event_id) IS NULL) THEN
      RAISE EXCEPTION 'preflight hash can only be recorded from a human approval of the current preflight result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.onboarding_stage IS NOT DISTINCT FROM OLD.onboarding_stage THEN RETURN NEW; END IF;
  IF OLD.onboarding_stage IS NULL THEN
    -- a legacy batch can be enrolled only at the start
    IF NEW.onboarding_stage <> 'intake' THEN RAISE EXCEPTION 'a batch enters the onboarding engine at intake' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding stage cannot be cleared' USING ERRCODE = 'check_violation'; END IF;
  IF onboarding_next_stage(OLD.onboarding_stage) IS DISTINCT FROM NEW.onboarding_stage THEN
    RAISE EXCEPTION 'stage % may only advance to %', OLD.onboarding_stage, onboarding_next_stage(OLD.onboarding_stage) USING ERRCODE = 'check_violation';
  END IF;
  -- The latest human advance event for this step, re-proved now (its completion must
  -- still be the latest result, and PASS or fully human-waived).
  SELECT * INTO adv FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'stage_advanced'
     AND e.stage = OLD.onboarding_stage AND e.to_stage = NEW.onboarding_stage
     AND (e.actor_kind = 'human' OR (e.actor_kind = 'system' AND NEW.onboarding_stage <> 'execute'
          AND (SELECT c.result->>'status' FROM onboarding_stage_events c WHERE c.id = e.completion_event_id) = 'PASS'))
   ORDER BY e.seq DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'stage advance needs a human stage_advanced event (or an operator advance on a PASS result)' USING ERRCODE = 'check_violation'; END IF;
  why := onboarding_completion_gate(adv.completion_event_id);
  IF why IS NOT NULL THEN RAISE EXCEPTION 'stage advance refused: %', why USING ERRCODE = 'check_violation'; END IF;
  IF NEW.onboarding_stage = 'execute' THEN
    IF NEW.approved_preflight_sha256 IS NULL OR NOT EXISTS (
      SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved' AND e.actor_kind = 'human'
        AND e.preflight_sha256 = NEW.approved_preflight_sha256 AND e.completion_event_id = adv.completion_event_id) THEN
      RAISE EXCEPTION 'execute needs an approved preflight for the current preflight result' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.onboarding_stage <> 'execute' THEN NEW.write_locked := TRUE; END IF;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION onboarding_auto_advance(p_batch UUID, p_completion UUID, p_actor_id TEXT)
RETURNS UUID LANGUAGE plpgsql AS $fn$
DECLARE bt conversion_batches%ROWTYPE; nxt TEXT; ev UUID; st TEXT;
BEGIN
  PERFORM onboarding_assert_actor('system', p_actor_id, FALSE);
  SELECT * INTO bt FROM conversion_batches WHERE id = p_batch FOR UPDATE;
  IF NOT FOUND OR bt.onboarding_stage IS NULL THEN RAISE EXCEPTION 'onboarding: no such engine batch' USING ERRCODE = 'check_violation'; END IF;
  SELECT result->>'status' INTO st FROM onboarding_stage_events WHERE id = p_completion AND batch_id = p_batch AND event_type = 'stage_completed';
  IF st IS DISTINCT FROM 'PASS' THEN RAISE EXCEPTION 'operator advance refused: the result is not a plain PASS' USING ERRCODE = 'check_violation'; END IF;
  nxt := onboarding_next_stage(bt.onboarding_stage);
  INSERT INTO onboarding_stage_events (batch_id, event_type, stage, to_stage, completion_event_id, actor_kind, actor_id)
  VALUES (p_batch, 'stage_advanced', bt.onboarding_stage, nxt, p_completion, 'system', p_actor_id)      -- validate trigger: PASS, routine target, latest result
  RETURNING id INTO ev;
  UPDATE conversion_batches SET onboarding_stage = nxt WHERE id = p_batch;                              -- guard re-proves
  RETURN ev;
END;
$fn$;
REVOKE ALL ON FUNCTION onboarding_auto_advance(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_auto_advance(UUID, UUID, TEXT) TO service_role;

COMMIT;

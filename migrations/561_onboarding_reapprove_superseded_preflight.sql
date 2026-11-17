-- ============================================================================
-- 561_onboarding_reapprove_superseded_preflight.sql  (Ed 2026-11-17, Waterview 7/31 conversion)
-- ----------------------------------------------------------------------------
-- The owner can approve a REBUILT preflight after approving an earlier one that was superseded.
--
-- Why: conversion_batches.approved_preflight_sha256 was strictly write-once. Waterview's first approved
-- preflight was refused by EXECUTE (all-or-nothing, nothing posted); the preflight was then rebuilt with a
-- new fingerprint, and the owner's approval of the new fingerprint was refused by the database
-- ("approved preflight hash is write-once"), leaving the conversion with no way forward.
--
-- Change: conversion_batches_onboarding_guard = the 485 body unchanged except the write-once rule. The
-- approved hash may be replaced only when ALL hold: the batch is (and stays) in preflight, it is not
-- posted, the new value is not null, and the preflight the previous approval was bound to is no longer
-- the current result (onboarding_completion_gate not null). The replacement must still pass the existing
-- check: a human preflight_approved event for that exact hash on the CURRENT preflight result. From
-- execute on the approval is fixed. The earlier approval event stays in the audit trail.
--
-- No existing row changes. Record ownership: no new table.
-- ============================================================================
BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('conversion_batches_onboarding_guard()') IS NULL OR to_regprocedure('onboarding_completion_gate(uuid)') IS NULL THEN
    RAISE EXCEPTION '561 needs 481/485 (conversion_batches_onboarding_guard, onboarding_completion_gate)';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION conversion_batches_onboarding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE adv onboarding_stage_events%ROWTYPE; why TEXT;
BEGIN
  -- The approved preflight hash is set in preflight, from a human approval bound to the CURRENT (latest)
  -- preflight result. 561: once set it may be REPLACED only while the batch is still in preflight and
  -- unposted, and only when the preflight it approved has been superseded by a newer result (an approval
  -- never authorizes a different fingerprint; the replacement passes the same human-approval check below).
  -- From execute on it is fixed.
  IF NEW.approved_preflight_sha256 IS DISTINCT FROM OLD.approved_preflight_sha256 THEN
    IF OLD.approved_preflight_sha256 IS NOT NULL AND (
         OLD.onboarding_stage IS DISTINCT FROM 'preflight' OR NEW.onboarding_stage IS DISTINCT FROM 'preflight'
      OR NEW.status = 'posted' OR NEW.approved_preflight_sha256 IS NULL
      OR EXISTS (SELECT 1 FROM onboarding_stage_events e WHERE e.batch_id = NEW.id AND e.event_type = 'preflight_approved'
                   AND e.preflight_sha256 = OLD.approved_preflight_sha256 AND onboarding_completion_gate(e.completion_event_id) IS NULL)) THEN
      RAISE EXCEPTION 'approved preflight hash is write-once (it may be replaced only in preflight, after the preflight it approved was superseded)' USING ERRCODE = 'check_violation';
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

COMMIT;

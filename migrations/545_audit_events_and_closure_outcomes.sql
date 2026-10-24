-- ============================================================================
-- 545_audit_events_and_closure_outcomes.sql  (Ed 2026-10-24)
-- ----------------------------------------------------------------------------
-- Design: .claude/audits/2026-10-24/cg_fine_authority_and_h360_plan_v2.md,
-- sections 3 and 5. Additive only. NO existing row is changed or backfilled.
--
-- 1) audit_events: ONE canonical, append-only record of meaningful staff actions
--    (closing a case, recording a certified number, editing or deleting a note,
--    removing a file, advancing or reducing an enforcement stage). Every row names
--    the employee from their own sign-in (actor_user_id NOT NULL, FK
--    user_profiles), what changed (entity, field, before, after) and why (reason
--    NOT NULL and not blank).
--      - service_role may only SELECT and INSERT. UPDATE, DELETE and TRUNCATE are
--        revoked, and a trigger raises on any UPDATE, DELETE or TRUNCATE, so not
--        even the table owner can rewrite history without first dropping the
--        trigger (itself a visible schema change).
--      - Existing per-domain logs (property_enforcement_state_audit,
--        record_finalization_log, invoice_events, the timeline notes, ...) keep
--        working unchanged; nothing is migrated out of them.
--    Record ownership: association_record (a record of actions taken on the
--    association's records). community_id is carried on every row that has one,
--    so a community's audit history exports with its books.
--
-- 2) violations: closure outcome columns (all nullable, no default):
--      closure_outcome            cured_verified | cured_reported | voided_error |
--                                 duplicate | administrative | expired_unverified
--      closure_reason             why it was closed (required with an outcome)
--      duplicate_of_violation_id  the surviving case (required for duplicate)
--      closed_by_user_id          the employee who closed it
--      stage_at_closure           the stage the case was at when it was closed
--    resolved_via keeps its existing values; a CHECK holds the compatible
--    mapping: cured_* -> 'cured'; voided_error, duplicate -> 'voided';
--    administrative, expired_unverified -> 'withdrawn'. current_stage behaviour
--    is unchanged (a closed case still reads 'cured', as many readers expect).
--    Every existing closed case keeps closure_outcome NULL, which means
--    "legacy, unclassified": never counted automatically as a prior offense.
--
-- 3) stage_at_closure is protected by a trigger: once set it can never be
--    changed, and it can be cleared only by an explicit reopen that FIRST appends
--    a 'violation.reopened' audit event for the case (after it was closed).
--
-- 4) close_violation_with_audit(): closes a case, writes its audit event and its
--    timeline note in ONE transaction, so a case can never be closed without the
--    record of who closed it, when, why and at what stage. Callable by
--    service_role only (revoked from PUBLIC, anon, authenticated).
--
-- Rollback: code first (revert the PR). The schema can stay: the columns are
-- nullable and unused by old code, the table is append-only history and is
-- never dropped. If the stage trigger must go:
--   DROP TRIGGER trg_violations_stage_at_closure_guard ON violations;
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) audit_events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id                uuid        NOT NULL DEFAULT gen_random_uuid(),
  community_id      uuid,
  actor_user_id     uuid        NOT NULL,
  actor_name        text,
  entity_type       text        NOT NULL,
  entity_id         text        NOT NULL,
  action            text        NOT NULL,
  field             text,
  previous_value    jsonb,
  new_value         jsonb,
  reason            text        NOT NULL,
  route             text,
  record_ownership  text        NOT NULL DEFAULT 'association_record',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_pkey PRIMARY KEY (id),
  CONSTRAINT audit_events_community_id_fkey FOREIGN KEY (community_id) REFERENCES communities(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES user_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT audit_events_reason_not_blank CHECK (length(btrim(reason)) > 0),
  CONSTRAINT audit_events_text_not_blank CHECK (length(btrim(entity_type)) > 0 AND length(btrim(entity_id)) > 0 AND length(btrim(action)) > 0),
  CONSTRAINT audit_events_record_ownership_check CHECK (record_ownership IN ('association_record', 'workpaper', 'mixed'))
);
COMMENT ON TABLE audit_events IS 'Canonical append-only audit trail (migration 545). Insert-only; a trigger rejects UPDATE, DELETE and TRUNCATE. Written by lib/audit/record_event.js and close_violation_with_audit().';

CREATE INDEX IF NOT EXISTS idx_audit_events_entity ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_community ON audit_events (community_id, created_at DESC) WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events (actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_audit_events_append_only ON audit_events;
CREATE TRIGGER trg_audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS trg_audit_events_no_truncate ON audit_events;
CREATE TRIGGER trg_audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON audit_events FROM PUBLIC;
REVOKE ALL ON audit_events FROM anon, authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM service_role;
GRANT SELECT, INSERT ON audit_events TO service_role;

-- ---------------------------------------------------------------------------
-- 2) violations: closure outcome columns (nullable; existing rows untouched)
-- ---------------------------------------------------------------------------
ALTER TABLE violations ADD COLUMN IF NOT EXISTS closure_outcome text;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS closure_reason text;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS duplicate_of_violation_id uuid;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS closed_by_user_id uuid;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS stage_at_closure text;

COMMENT ON COLUMN violations.closure_outcome IS 'How the case was closed (migration 545). NULL on a closed case = legacy, unclassified: never counted automatically as a prior offense.';
COMMENT ON COLUMN violations.stage_at_closure IS 'The stage the case was at when it was closed. Immutable once set (trg_violations_stage_at_closure_guard); cleared only by an audited reopen.';

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'violations_closure_outcome_check') THEN
    ALTER TABLE violations ADD CONSTRAINT violations_closure_outcome_check
      CHECK (closure_outcome IN ('cured_verified', 'cured_reported', 'voided_error', 'duplicate', 'administrative', 'expired_unverified'));
  END IF;
  -- An outcome only on a closed case, always with a reason, and resolved_via
  -- always the compatible legacy value.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'violations_closure_coherent') THEN
    ALTER TABLE violations ADD CONSTRAINT violations_closure_coherent CHECK (
      closure_outcome IS NULL OR (
        resolved_at IS NOT NULL
        AND length(btrim(coalesce(closure_reason, ''))) > 0
        AND (
          (closure_outcome IN ('cured_verified', 'cured_reported') AND resolved_via = 'cured')
          OR (closure_outcome IN ('voided_error', 'duplicate') AND resolved_via = 'voided')
          OR (closure_outcome IN ('administrative', 'expired_unverified') AND resolved_via = 'withdrawn')
        )
      )
    );
  END IF;
  -- A duplicate names its surviving case, and never itself.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'violations_duplicate_survivor') THEN
    ALTER TABLE violations ADD CONSTRAINT violations_duplicate_survivor CHECK (
      (closure_outcome IS DISTINCT FROM 'duplicate' OR duplicate_of_violation_id IS NOT NULL)
      AND (duplicate_of_violation_id IS NULL OR duplicate_of_violation_id <> id)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'violations_duplicate_of_violation_id_fkey') THEN
    ALTER TABLE violations ADD CONSTRAINT violations_duplicate_of_violation_id_fkey
      FOREIGN KEY (duplicate_of_violation_id) REFERENCES violations(id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'violations_closed_by_user_id_fkey') THEN
    ALTER TABLE violations ADD CONSTRAINT violations_closed_by_user_id_fkey
      FOREIGN KEY (closed_by_user_id) REFERENCES user_profiles(id) ON DELETE RESTRICT;
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS idx_violations_duplicate_of ON violations (duplicate_of_violation_id) WHERE duplicate_of_violation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_violations_closed_by ON violations (closed_by_user_id) WHERE closed_by_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) stage_at_closure is immutable once set (except an audited reopen)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION violations_stage_at_closure_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.stage_at_closure IS NOT NULL AND NEW.stage_at_closure IS DISTINCT FROM OLD.stage_at_closure THEN
    -- The one exception: an explicit reopen clears it, the case is reopened in
    -- the same update, and a 'violation.reopened' audit event for this case was
    -- appended after it was closed.
    IF NEW.stage_at_closure IS NULL AND NEW.resolved_at IS NULL AND EXISTS (
      SELECT 1 FROM audit_events ae
       WHERE ae.entity_type = 'violation'
         AND ae.entity_id = OLD.id::text
         AND ae.action = 'violation.reopened'
         AND ae.created_at >= coalesce(OLD.resolved_at, '-infinity'::timestamptz)
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'violations.stage_at_closure cannot change once set (case %); reopen the case through an audited reopen instead', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_violations_stage_at_closure_guard ON violations;
CREATE TRIGGER trg_violations_stage_at_closure_guard
  BEFORE UPDATE ON violations
  FOR EACH ROW EXECUTE FUNCTION violations_stage_at_closure_guard();

-- ---------------------------------------------------------------------------
-- 4) close a case + its audit event + its timeline note, atomically
-- ---------------------------------------------------------------------------
-- Returns {status: 'closed' | 'already_resolved' | 'stage_changed' | 'not_found', ...}.
-- The caller (api/homeowner_360.js) validates the outcome, survivor and evidence
-- first; the database CHECKs above hold the same rules regardless of caller.
CREATE OR REPLACE FUNCTION close_violation_with_audit(
  p_violation_id     uuid,
  p_expected_stage   text,
  p_closure_outcome  text,
  p_closure_reason   text,
  p_resolved_via     text,
  p_resolved_notes   text,
  p_duplicate_of     uuid,
  p_actor_user_id    uuid,
  p_actor_name       text,
  p_route            text,
  p_evidence         jsonb,
  p_timeline_subject text,
  p_timeline_content text
) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v      violations%ROWTYPE;
  v_now  timestamptz := now();
  v_evt  uuid;
BEGIN
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'close_violation_with_audit: actor is required' USING ERRCODE = 'not_null_violation';
  END IF;
  SELECT * INTO v FROM violations WHERE id = p_violation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;
  IF v.resolved_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_resolved');
  END IF;
  IF v.current_stage IS DISTINCT FROM p_expected_stage THEN
    RETURN jsonb_build_object('status', 'stage_changed', 'current_stage', v.current_stage);
  END IF;

  UPDATE violations SET
    resolved_at               = v_now,
    resolved_via              = p_resolved_via,
    resolved_notes            = p_resolved_notes,
    current_stage             = 'cured',
    closure_outcome           = p_closure_outcome,
    closure_reason            = p_closure_reason,
    duplicate_of_violation_id = p_duplicate_of,
    closed_by_user_id         = p_actor_user_id,
    stage_at_closure          = v.current_stage
  WHERE id = p_violation_id;

  INSERT INTO audit_events (community_id, actor_user_id, actor_name, entity_type, entity_id, action, field,
                            previous_value, new_value, reason, route)
  VALUES (
    v.community_id, p_actor_user_id, p_actor_name, 'violation', v.id::text, 'violation.closed', NULL,
    jsonb_build_object('current_stage', v.current_stage, 'resolved_at', v.resolved_at, 'resolved_via', v.resolved_via,
                       'resolved_notes', v.resolved_notes, 'closure_outcome', v.closure_outcome),
    jsonb_build_object('current_stage', 'cured', 'resolved_at', v_now, 'resolved_via', p_resolved_via,
                       'resolved_notes', p_resolved_notes, 'closure_outcome', p_closure_outcome,
                       'closure_reason', p_closure_reason, 'duplicate_of_violation_id', p_duplicate_of,
                       'closed_by_user_id', p_actor_user_id, 'stage_at_closure', v.current_stage,
                       'evidence', p_evidence),
    p_closure_reason, p_route
  ) RETURNING id INTO v_evt;

  IF p_timeline_subject IS NOT NULL THEN
    INSERT INTO interactions (community_id, property_id, violation_id, type, direction, source, subject, content,
                              sent_by_user_id, sent_at, notes)
    VALUES (v.community_id, v.property_id, v.id, 'observation_note', 'internal', 'manual',
            left(p_timeline_subject, 200), p_timeline_content, p_actor_user_id, v_now, 'via Homeowner 360 resolve');
  END IF;

  RETURN jsonb_build_object('status', 'closed', 'closed_at', v_now, 'prior_stage', v.current_stage, 'audit_event_id', v_evt);
END;
$fn$;

REVOKE ALL ON FUNCTION close_violation_with_audit(uuid, text, text, text, text, text, uuid, uuid, text, text, jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_violation_with_audit(uuid, text, text, text, text, text, uuid, uuid, text, text, jsonb, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION close_violation_with_audit(uuid, text, text, text, text, text, uuid, uuid, text, text, jsonb, text, text) TO service_role;

COMMIT;

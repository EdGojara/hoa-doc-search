-- ============================================================================
-- 577_owner_authorization_service.sql  (Ed 2026-11-25)
-- ----------------------------------------------------------------------------
-- The shared Owner Authorization Service, step 1: one foundation for every AI
-- teammate, module and channel, built on the existing mechanisms (no competing
-- approval system):
--   * owner_authorizations (554-556, 566): the record of an INDIVIDUAL approval
--     request, its exact items and fingerprints, the verified evidence and the
--     execution. Gains who COORDINATES (Amanda by default), which teammate
--     EXECUTES, and a SENSITIVITY TIER. A tier-3 action (movement of money,
--     vendor bank details, live payments, user permissions) can never be
--     authorized through this record's reply channels: it needs the signed-in
--     owner with step-up.
--   * owner_execution_grants (567): TIME-LIMITED grants (at most 24 hours, as
--     before) and, new, STANDING delegated authority (a written policy, at most
--     one year, revocable). Both stay issuable only from the owner's signed-in
--     session; the per-run ceiling and covered processes still apply.
--   * authorization_events (new): ONE append-only ledger every path writes to:
--     the requesting teammate, the coordinator, the authorizing person and the
--     executing teammate recorded separately, the action and its exact version,
--     the channel, the evidence and the result. Amanda reads it to follow
--     through; a follow-up she reports is linked to the event it answers.
-- Module controls, identity checks, fingerprints and duplicate protection are
-- unchanged: execution still runs through each module's own functions.
--
-- Record ownership: association_record (authorization evidence for the
-- association's records). Server-only: RLS on, service_role grants.
-- ============================================================================

BEGIN;

-- 1) Individual approvals: coordinator, executor, sensitivity tier ------------
ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS coordinator text NOT NULL DEFAULT 'ai-team:amanda';
ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS executor text;
ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS sensitivity_tier smallint NOT NULL DEFAULT 1;
ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_sensitivity_tier_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_sensitivity_tier_check CHECK (sensitivity_tier BETWEEN 1 AND 3);
ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_coordinator_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_coordinator_check CHECK (length(btrim(coordinator)) > 0);

-- The request's coordinator, executor and tier are fixed once requested (as the items are).
CREATE OR REPLACE FUNCTION owner_authorizations_service_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (NEW.coordinator, NEW.executor, NEW.sensitivity_tier) IS DISTINCT FROM (OLD.coordinator, OLD.executor, OLD.sensitivity_tier) THEN
    RAISE EXCEPTION 'an owner authorization''s coordinator, executor and sensitivity tier are fixed' USING ERRCODE = 'check_violation';
  END IF;
  -- Tier 3 (movement of money and other sensitive actions) is never authorized by a reply.
  IF OLD.status = 'requested' AND NEW.status = 'authorized' AND NEW.sensitivity_tier >= 3 THEN
    RAISE EXCEPTION 'a tier-3 action needs the signed-in owner with step-up; it cannot be authorized by reply' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_owner_authorizations_service_guard ON owner_authorizations;
CREATE TRIGGER trg_owner_authorizations_service_guard BEFORE UPDATE ON owner_authorizations FOR EACH ROW EXECUTE FUNCTION owner_authorizations_service_guard();

-- 2) Grants: time-limited (unchanged) and standing delegated authority ---------
ALTER TABLE owner_execution_grants ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'time_limited';
ALTER TABLE owner_execution_grants ADD COLUMN IF NOT EXISTS policy jsonb;
ALTER TABLE owner_execution_grants DROP CONSTRAINT IF EXISTS owner_execution_grants_kind_check;
ALTER TABLE owner_execution_grants ADD CONSTRAINT owner_execution_grants_kind_check CHECK (kind IN ('time_limited', 'standing'));
ALTER TABLE owner_execution_grants DROP CONSTRAINT IF EXISTS owner_execution_grants_window;
ALTER TABLE owner_execution_grants ADD CONSTRAINT owner_execution_grants_window CHECK (expires_at > issued_at AND (
  (kind = 'time_limited' AND expires_at <= issued_at + interval '24 hours')
  OR (kind = 'standing' AND expires_at <= issued_at + interval '366 days' AND jsonb_typeof(policy) = 'object' AND length(btrim(coalesce(policy->>'description', ''))) >= 10)));

-- A grant never changes except to be revoked once (now including its kind and policy).
CREATE OR REPLACE FUNCTION owner_execution_grants_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an execution grant is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF (NEW.id, NEW.owner_user_id, NEW.owner_email, NEW.community_id, NEW.processes, NEW.max_run_cents, NEW.note, NEW.issued_at, NEW.expires_at, NEW.kind, NEW.policy)
     IS DISTINCT FROM (OLD.id, OLD.owner_user_id, OLD.owner_email, OLD.community_id, OLD.processes, OLD.max_run_cents, OLD.note, OLD.issued_at, OLD.expires_at, OLD.kind, OLD.policy) THEN
    RAISE EXCEPTION 'an execution grant cannot be changed; revoke it and issue a new one' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'an execution grant is revoked once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

-- 3) One ledger for every authorization event ----------------------------------
CREATE TABLE IF NOT EXISTS authorization_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  community_id          uuid REFERENCES communities(id) ON DELETE RESTRICT,
  authority_kind        text NOT NULL CHECK (authority_kind IN ('request', 'grant', 'standing', 'in_app')),
  authorization_id      uuid REFERENCES owner_authorizations(id) ON DELETE RESTRICT,
  grant_id              uuid REFERENCES owner_execution_grants(id) ON DELETE RESTRICT,
  action_type           text NOT NULL CHECK (length(btrim(action_type)) > 0),
  target_id             text,
  fingerprint           text,
  event                 text NOT NULL CHECK (event IN ('requested', 'sent', 'authorized', 'declined', 'change_requested', 'clarification_requested',
                          'expired', 'revoked', 'executed', 'execution_failed', 'reported')),
  channel               text CHECK (channel IS NULL OR channel IN ('email', 'in_app', 'conversation', 'grant', 'standing', 'voice', 'integration', 'system')),
  requested_by          text,
  coordinator           text,
  authorized_by_user_id text,
  authorized_by_email   text,
  executed_by           text,
  related_event_id      uuid REFERENCES authorization_events(id) ON DELETE RESTRICT,
  evidence              jsonb,
  result                jsonb,
  note                  text,
  CONSTRAINT authorization_events_executor_named CHECK (event NOT IN ('executed', 'execution_failed') OR length(btrim(coalesce(executed_by, ''))) > 0),
  CONSTRAINT authorization_events_authorizer_named CHECK (event <> 'authorized' OR length(btrim(coalesce(authorized_by_email, ''))) > 0),
  CONSTRAINT authorization_events_report_links CHECK (event <> 'reported' OR related_event_id IS NOT NULL)
);
COMMENT ON TABLE authorization_events IS 'association_record: append-only ledger of every owner authorization event across AI teammates, modules and channels (migration 577). Requesting teammate, coordinator, authorizing person and executing teammate are recorded separately.';
CREATE INDEX IF NOT EXISTS idx_authorization_events_authorization ON authorization_events (authorization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_authorization_events_grant ON authorization_events (grant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_authorization_events_target ON authorization_events (action_type, target_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_authorization_events_followup ON authorization_events (coordinator, occurred_at) WHERE event IN ('executed', 'execution_failed');
CREATE INDEX IF NOT EXISTS idx_authorization_events_related ON authorization_events (related_event_id);

CREATE OR REPLACE FUNCTION authorization_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'authorization events are permanent; record a new event instead' USING ERRCODE = 'check_violation';
END;
$fn$;
DROP TRIGGER IF EXISTS trg_authorization_events_append_only ON authorization_events;
CREATE TRIGGER trg_authorization_events_append_only BEFORE UPDATE OR DELETE ON authorization_events FOR EACH ROW EXECUTE FUNCTION authorization_events_append_only();

ALTER TABLE authorization_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON authorization_events TO service_role;

COMMIT;

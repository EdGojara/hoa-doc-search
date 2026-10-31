-- ============================================================================
-- 554_owner_delegated_approvals.sql  (Ed 2026-10-31)
-- ----------------------------------------------------------------------------
-- The owner decides; the AI team executes. A second, narrow approval path for
-- conversion adjustments / policies, beside the unchanged in-app one:
--
--   1. An agent REQUESTS an owner authorization: an exact list of items
--      (object type, id, the fingerprint the owner will see), a subject, an
--      expiry. Every item must be proposed with that fingerprint right now.
--      A request authorizes nothing.
--   2. The OWNER authorizes it by replying "approved" from the owner's own
--      mailbox to the request email. Trusted's inbox reader records that,
--      with the evidence (internet message id, Exchange "AuthAs: Internal",
--      received time, the reply text): the request becomes AUTHORIZED, bound
--      to the owner's user id and email. A request that has expired cannot be.
--   3. An agent EXECUTES it: each item is approved through
--      conversion_decide_object_delegated, which refuses anything the
--      authorization does not list with that exact fingerprint, anything not
--      proposed, an unauthorized / expired / executed authorization, and a
--      closed batch. The record says both things truthfully:
--        approved_by_user_id = the OWNER (who authorized),
--        approval_channel = 'owner_delegation', decision_note = the authorization id,
--        the audit event: actor_kind 'agent' + the agent id (who executed),
--        detail.authorized_by / authorization_id / evidence message id.
--
-- Not changed: the in-app path (owner, human, in_app) and everything it checks;
-- rejections stay in-app only; bridge decisions, waivers, preflight approval and
-- EXECUTE are untouched (no delegated path for them).
--
-- Record ownership: association_record (the owner's authorization of the HOA's
-- conversion accounting, and its evidence).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS owner_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope                 text NOT NULL CHECK (scope IN ('conversion_objects')),
  subject               text NOT NULL,
  summary               text NOT NULL CHECK (length(btrim(summary)) >= 10),
  items                 jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 200),
  items_sha256          text NOT NULL,
  owner_email           text NOT NULL,
  requested_by          text NOT NULL CHECK (length(btrim(requested_by)) > 0),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'authorized', 'executed', 'expired', 'revoked')),
  authorized_by_user_id text,
  authorized_by_email   text,
  authorized_at         timestamptz,
  evidence              jsonb,
  executed_at           timestamptz,
  execution             jsonb,
  CONSTRAINT owner_authorizations_subject_unique UNIQUE (subject),
  CONSTRAINT owner_authorizations_authorized_shape CHECK (status IN ('requested', 'expired', 'revoked') OR (authorized_by_user_id IS NOT NULL AND authorized_by_email IS NOT NULL
    AND authorized_at IS NOT NULL AND evidence ? 'internet_message_id' AND evidence->>'auth_as' = 'Internal'))
);
COMMENT ON TABLE owner_authorizations IS
  'An owner''s authorization of an exact list of conversion items, given by email reply from the owner''s own mailbox, executed by an agent (554). The items, subject and fingerprints never change; status moves forward only.';

CREATE OR REPLACE FUNCTION owner_authorizations_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an owner authorization is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.authorized_by_user_id IS NOT NULL OR NEW.authorized_at IS NOT NULL OR NEW.evidence IS NOT NULL OR NEW.executed_at IS NOT NULL THEN
      RAISE EXCEPTION 'an owner authorization is created as a request; only the owner''s reply authorizes it' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.items_sha256 IS DISTINCT FROM conversion_sha256_jsonb(NEW.items) THEN RAISE EXCEPTION 'items_sha256 must be the hash of the items' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.scope, NEW.subject, NEW.summary, NEW.items, NEW.items_sha256, NEW.owner_email, NEW.requested_by, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.scope, OLD.subject, OLD.summary, OLD.items, OLD.items_sha256, OLD.owner_email, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an owner authorization''s request is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF coalesce(current_setting('trusted.owner_authorization_writer', true), 'off') <> 'on' THEN
    RAISE EXCEPTION 'owner authorizations change only through their functions' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT ((OLD.status = 'requested' AND NEW.status IN ('authorized', 'expired', 'revoked')) OR (OLD.status = 'authorized' AND NEW.status IN ('executed', 'revoked')) OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'an owner authorization cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'requested' AND (NEW.authorized_by_user_id, NEW.authorized_by_email, NEW.authorized_at, NEW.evidence) IS DISTINCT FROM (OLD.authorized_by_user_id, OLD.authorized_by_email, OLD.authorized_at, OLD.evidence) THEN
    RAISE EXCEPTION 'an authorization and its evidence are permanent' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_owner_authorizations_guard ON owner_authorizations;
CREATE TRIGGER trg_owner_authorizations_guard BEFORE INSERT OR UPDATE OR DELETE ON owner_authorizations FOR EACH ROW EXECUTE FUNCTION owner_authorizations_guard();
GRANT SELECT, INSERT ON owner_authorizations TO service_role;

-- 1) Request: every item exists, is proposed, and carries the fingerprint listed.
CREATE OR REPLACE FUNCTION owner_authorization_request(p_subject text, p_summary text, p_items jsonb, p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE it jsonb; st text; fp text; new_id uuid; n int := 0;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    n := n + 1;
    IF it->>'object_type' = 'adjustment' THEN SELECT status, fingerprint INTO st, fp FROM conversion_adjustments WHERE id = (it->>'object_id')::uuid;
    ELSIF it->>'object_type' = 'policy' THEN SELECT status, fingerprint INTO st, fp FROM conversion_policies WHERE id = (it->>'object_id')::uuid;
    ELSE RAISE EXCEPTION 'item %: only adjustments and policies can be authorized', n USING ERRCODE = 'check_violation'; END IF;
    IF st IS DISTINCT FROM 'proposed' OR fp IS DISTINCT FROM it->>'fingerprint' THEN
      RAISE EXCEPTION 'item % (% %) is not proposed with that fingerprint', n, it->>'object_type', it->>'object_id' USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT (x->>'object_type') || (x->>'object_id')) FROM jsonb_array_elements(p_items) x) <> n THEN RAISE EXCEPTION 'an item is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at)
  VALUES ('conversion_objects', btrim(p_subject), p_summary, p_items, conversion_sha256_jsonb(p_items), lower(btrim(p_owner_email)), p_requested_by, now() + make_interval(hours => p_hours))
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', n, 'items_sha256', conversion_sha256_jsonb(p_items));
END;
$fn$;

-- 2) The owner's reply, as read from the owner's own mailbox by the server: authorizes the request.
CREATE OR REPLACE FUNCTION owner_authorization_record(p_id uuid, p_user_id text, p_email text, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE a owner_authorizations%ROWTYPE;
BEGIN
  SELECT * INTO a FROM owner_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such owner authorization' USING ERRCODE = 'check_violation'; END IF;
  IF a.status <> 'requested' THEN RAISE EXCEPTION 'this authorization is already %', a.status USING ERRCODE = 'check_violation'; END IF;
  IF now() > a.expires_at THEN RAISE EXCEPTION 'this authorization request expired at %', a.expires_at USING ERRCODE = 'check_violation'; END IF;
  IF lower(btrim(coalesce(p_email, ''))) <> a.owner_email THEN RAISE EXCEPTION 'only the owner the request was sent to can authorize it' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_user_id, ''))) = 0 THEN RAISE EXCEPTION 'the owner''s user id is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_evidence IS NULL OR NOT (p_evidence ? 'internet_message_id') OR p_evidence->>'auth_as' IS DISTINCT FROM 'Internal' THEN
    RAISE EXCEPTION 'the authorization needs the reply''s message id and an internal (authenticated) sender' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('trusted.owner_authorization_writer', 'on', true);
  UPDATE owner_authorizations SET status = 'authorized', authorized_by_user_id = p_user_id, authorized_by_email = lower(btrim(p_email)), authorized_at = now(), evidence = p_evidence WHERE id = p_id;
  PERFORM set_config('trusted.owner_authorization_writer', 'off', true);
  RETURN jsonb_build_object('id', p_id, 'status', 'authorized');
END;
$fn$;

-- 3) Execution, item by item: only what the authorization lists, with that exact fingerprint.
CREATE OR REPLACE FUNCTION conversion_decide_object_delegated(p_authorization uuid, p_object_type text, p_object_id uuid, p_fingerprint text, p_agent_id text, p_agent_label text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE a owner_authorizations%ROWTYPE; bt conversion_batches%ROWTYPE; b uuid; cur_status text; cur_fp text; lbl text;
BEGIN
  PERFORM onboarding_assert_actor('agent', p_agent_id, FALSE);
  SELECT * INTO a FROM owner_authorizations WHERE id = p_authorization FOR SHARE;
  IF NOT FOUND OR a.status <> 'authorized' THEN RAISE EXCEPTION 'onboarding: no authorized owner authorization %', p_authorization USING ERRCODE = 'check_violation'; END IF;
  IF now() > a.expires_at THEN RAISE EXCEPTION 'onboarding: the owner authorization expired at %', a.expires_at USING ERRCODE = 'check_violation'; END IF;
  IF NOT (a.items @> jsonb_build_array(jsonb_build_object('object_type', p_object_type, 'object_id', p_object_id::text, 'fingerprint', p_fingerprint))) THEN
    RAISE EXCEPTION 'onboarding: the owner did not authorize this % with this fingerprint', p_object_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_object_type = 'adjustment' THEN SELECT batch_id, status, fingerprint INTO b, cur_status, cur_fp FROM conversion_adjustments WHERE id = p_object_id FOR UPDATE;
  ELSIF p_object_type = 'policy' THEN SELECT batch_id, status, fingerprint INTO b, cur_status, cur_fp FROM conversion_policies WHERE id = p_object_id FOR UPDATE;
  ELSE RAISE EXCEPTION 'onboarding: only adjustments and policies are approved' USING ERRCODE = 'check_violation'; END IF;
  IF b IS NULL THEN RAISE EXCEPTION 'onboarding: no such conversion %', p_object_type USING ERRCODE = 'check_violation'; END IF;
  bt := conversion_assert_batch_open(b);
  IF cur_status <> 'proposed' THEN RAISE EXCEPTION 'onboarding: this % is % (only a proposed one is decided)', p_object_type, cur_status USING ERRCODE = 'check_violation'; END IF;
  IF p_fingerprint IS DISTINCT FROM cur_fp THEN RAISE EXCEPTION 'onboarding: the fingerprint you reviewed is not this % (it may have been superseded)', p_object_type USING ERRCODE = 'check_violation'; END IF;
  lbl := a.authorized_by_email || ' (authorized by email reply; executed by ' || coalesce(nullif(btrim(p_agent_label), ''), p_agent_id) || ')';
  PERFORM set_config('onboarding.object_writer', 'on', true);
  IF p_object_type = 'adjustment' THEN
    UPDATE conversion_adjustments SET status = 'approved', approved_by_user_id = a.authorized_by_user_id, approved_by_label = lbl, approved_at = now(), approval_channel = 'owner_delegation',
           decision_note = 'Owner authorization ' || a.id::text WHERE id = p_object_id;
  ELSE
    UPDATE conversion_policies SET status = 'approved', approved_by_user_id = a.authorized_by_user_id, approved_by_label = lbl, approved_at = now(), approval_channel = 'owner_delegation',
           decision_note = 'Owner authorization ' || a.id::text WHERE id = p_object_id;
  END IF;
  PERFORM set_config('onboarding.object_writer', 'off', true);
  INSERT INTO conversion_object_events (batch_id, community_id, object_type, object_id, event, fingerprint, actor_kind, actor_id, actor_label, channel, detail)
  VALUES (b, bt.community_id, p_object_type, p_object_id, 'approved', cur_fp, 'agent', p_agent_id, coalesce(nullif(btrim(p_agent_label), ''), p_agent_id), 'owner_delegation',
          jsonb_build_object('authorization_id', a.id, 'authorized_by_user_id', a.authorized_by_user_id, 'authorized_by_email', a.authorized_by_email, 'authorized_at', a.authorized_at,
                             'evidence_message_id', a.evidence->>'internet_message_id', 'items_sha256', a.items_sha256, 'batch_stage', bt.onboarding_stage));
  RETURN jsonb_build_object('id', p_object_id, 'status', 'approved', 'fingerprint', cur_fp, 'authorization_id', a.id);
END;
$fn$;

-- 4) Close the authorization once its items are executed (the per-item outcome is kept).
CREATE OR REPLACE FUNCTION owner_authorization_mark_executed(p_id uuid, p_execution jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('trusted.owner_authorization_writer', 'on', true);
  UPDATE owner_authorizations SET status = 'executed', executed_at = now(), execution = p_execution WHERE id = p_id AND status = 'authorized';
  IF NOT FOUND THEN RAISE EXCEPTION 'only an authorized owner authorization is marked executed' USING ERRCODE = 'check_violation'; END IF;
  PERFORM set_config('trusted.owner_authorization_writer', 'off', true);
  RETURN jsonb_build_object('id', p_id, 'status', 'executed');
END;
$fn$;

REVOKE ALL ON FUNCTION owner_authorization_request(text, text, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION owner_authorization_record(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION conversion_decide_object_delegated(uuid, text, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION owner_authorization_mark_executed(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION owner_authorization_request(text, text, jsonb, text, text, integer), owner_authorization_record(uuid, text, text, jsonb),
  conversion_decide_object_delegated(uuid, text, uuid, text, text, text), owner_authorization_mark_executed(uuid, jsonb) TO service_role;

-- The approval records accept the delegated channel (an owner-delegated approval names the owner as
-- approver), and the audit trail accepts its event: approved by an AGENT, on the owner's authorization.
ALTER TABLE conversion_adjustments DROP CONSTRAINT IF EXISTS conversion_adjustments_approval_channel_check;
ALTER TABLE conversion_adjustments ADD CONSTRAINT conversion_adjustments_approval_channel_check CHECK (approval_channel IS NULL OR approval_channel IN ('in_app', 'owner_delegation'));
ALTER TABLE conversion_adjustments DROP CONSTRAINT IF EXISTS conversion_adjustments_approved;
ALTER TABLE conversion_adjustments ADD CONSTRAINT conversion_adjustments_approved CHECK (status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND approval_channel IN ('in_app', 'owner_delegation')));
ALTER TABLE conversion_policies DROP CONSTRAINT IF EXISTS conversion_policies_approval_channel_check;
ALTER TABLE conversion_policies ADD CONSTRAINT conversion_policies_approval_channel_check CHECK (approval_channel IS NULL OR approval_channel IN ('in_app', 'owner_delegation'));
ALTER TABLE conversion_policies DROP CONSTRAINT IF EXISTS conversion_policies_approved;
ALTER TABLE conversion_policies ADD CONSTRAINT conversion_policies_approved CHECK (status <> 'approved' OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND approval_channel IN ('in_app', 'owner_delegation')));
ALTER TABLE conversion_object_events DROP CONSTRAINT IF EXISTS conversion_object_events_channel_check;
ALTER TABLE conversion_object_events ADD CONSTRAINT conversion_object_events_channel_check CHECK (channel IS NULL OR channel IN ('in_app', 'operator', 'agent', 'owner_delegation'));
ALTER TABLE conversion_object_events DROP CONSTRAINT IF EXISTS conversion_object_events_decision_human;
ALTER TABLE conversion_object_events ADD CONSTRAINT conversion_object_events_decision_human CHECK (event NOT IN ('approved', 'rejected')
  OR (actor_kind = 'human' AND channel = 'in_app' AND fingerprint IS NOT NULL)
  OR (event = 'approved' AND actor_kind = 'agent' AND channel = 'owner_delegation' AND fingerprint IS NOT NULL AND detail ? 'authorization_id' AND detail ? 'evidence_message_id'));

COMMIT;

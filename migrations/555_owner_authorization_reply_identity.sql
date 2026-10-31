-- ============================================================================
-- 555_owner_authorization_reply_identity.sql  (Ed 2026-10-31)
-- ----------------------------------------------------------------------------
-- Tightens migration 554: an owner authorization is accepted only as a VERIFIED
-- REPLY to the exact request email Trusted sent, not merely a message from the
-- owner's address with a matching subject.
--
--   * The request email's own Microsoft 365 identity is recorded once, when it is
--     sent (owner_authorization_sent): its Internet message id and conversation id.
--     A request that was never sent cannot be authorized.
--   * owner_authorization_record now requires, in the reply's evidence:
--       in_reply_to (or references) = the request's Internet message id,
--       conversation_id = the request's conversation id,
--       auth_as = Internal with an auth_source and auth_mechanism (Exchange's
--       authenticated sender inside the tenant), and the From and Sender of the
--       reply both the owner.
--   * The stored authorization shape (CHECK) requires the same evidence keys.
-- Applies only to owner_authorizations (554); nothing else changes.
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS request_message_id text;
ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS request_conversation_id text;
ALTER TABLE owner_authorizations ADD COLUMN IF NOT EXISTS request_sent_at timestamptz;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_authorized_shape;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_authorized_shape CHECK (status IN ('requested', 'expired', 'revoked') OR (
  authorized_by_user_id IS NOT NULL AND authorized_by_email IS NOT NULL AND authorized_at IS NOT NULL
  AND request_message_id IS NOT NULL AND request_conversation_id IS NOT NULL
  AND evidence ? 'internet_message_id' AND evidence->>'auth_as' = 'Internal' AND evidence ? 'auth_source' AND evidence ? 'auth_mechanism'
  AND evidence->>'conversation_id' = request_conversation_id
  AND (evidence->>'in_reply_to' = request_message_id OR position(request_message_id IN coalesce(evidence->>'references', '')) > 0)));

-- The guard: the request message identity is written ONCE (by owner_authorization_sent), never changed.
CREATE OR REPLACE FUNCTION owner_authorizations_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'an owner authorization is permanent' USING ERRCODE = 'check_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'requested' OR NEW.authorized_by_user_id IS NOT NULL OR NEW.authorized_at IS NOT NULL OR NEW.evidence IS NOT NULL OR NEW.executed_at IS NOT NULL
       OR NEW.request_message_id IS NOT NULL OR NEW.request_conversation_id IS NOT NULL OR NEW.request_sent_at IS NOT NULL THEN
      RAISE EXCEPTION 'an owner authorization is created as an unsent request; only the owner''s reply authorizes it' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.items_sha256 IS DISTINCT FROM conversion_sha256_jsonb(NEW.items) THEN RAISE EXCEPTION 'items_sha256 must be the hash of the items' USING ERRCODE = 'check_violation'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.scope, NEW.subject, NEW.summary, NEW.items, NEW.items_sha256, NEW.owner_email, NEW.requested_by, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM (OLD.id, OLD.scope, OLD.subject, OLD.summary, OLD.items, OLD.items_sha256, OLD.owner_email, OLD.requested_by, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'an owner authorization''s request is fixed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.request_message_id IS NOT NULL AND (NEW.request_message_id, NEW.request_conversation_id, NEW.request_sent_at) IS DISTINCT FROM (OLD.request_message_id, OLD.request_conversation_id, OLD.request_sent_at) THEN
    RAISE EXCEPTION 'the request email''s identity is recorded once' USING ERRCODE = 'check_violation';
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

-- The request email was sent: record its Microsoft 365 identity (once).
CREATE OR REPLACE FUNCTION owner_authorization_sent(p_id uuid, p_message_id text, p_conversation_id text)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE a owner_authorizations%ROWTYPE;
BEGIN
  SELECT * INTO a FROM owner_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR a.status <> 'requested' THEN RAISE EXCEPTION 'only an open request records its email' USING ERRCODE = 'check_violation'; END IF;
  IF a.request_message_id IS NOT NULL THEN RAISE EXCEPTION 'the request email is already recorded' USING ERRCODE = 'check_violation'; END IF;
  IF coalesce(p_message_id, '') !~ '^<[^<>\s]+@[^<>\s]+>$' OR length(btrim(coalesce(p_conversation_id, ''))) < 8 THEN
    RAISE EXCEPTION 'the request email''s Internet message id (<...@...>) and conversation id are required' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('trusted.owner_authorization_writer', 'on', true);
  UPDATE owner_authorizations SET request_message_id = p_message_id, request_conversation_id = p_conversation_id, request_sent_at = now() WHERE id = p_id;
  PERFORM set_config('trusted.owner_authorization_writer', 'off', true);
  RETURN jsonb_build_object('id', p_id, 'request_message_id', p_message_id);
END;
$fn$;

-- The owner's reply: a verified reply to that exact email, from the owner, authenticated inside the tenant.
CREATE OR REPLACE FUNCTION owner_authorization_record(p_id uuid, p_user_id text, p_email text, p_evidence jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE a owner_authorizations%ROWTYPE; e jsonb := coalesce(p_evidence, '{}'::jsonb);
BEGIN
  SELECT * INTO a FROM owner_authorizations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such owner authorization' USING ERRCODE = 'check_violation'; END IF;
  IF a.status <> 'requested' THEN RAISE EXCEPTION 'this authorization is already %', a.status USING ERRCODE = 'check_violation'; END IF;
  IF now() > a.expires_at THEN RAISE EXCEPTION 'this authorization request expired at %', a.expires_at USING ERRCODE = 'check_violation'; END IF;
  IF a.request_message_id IS NULL THEN RAISE EXCEPTION 'this request was never sent; it cannot be authorized' USING ERRCODE = 'check_violation'; END IF;
  IF lower(btrim(coalesce(p_email, ''))) <> a.owner_email OR lower(coalesce(e->>'from', '')) <> a.owner_email OR lower(coalesce(e->>'sender', '')) <> a.owner_email THEN
    RAISE EXCEPTION 'only the owner the request was sent to can authorize it (From and Sender)' USING ERRCODE = 'check_violation';
  END IF;
  IF length(btrim(coalesce(p_user_id, ''))) = 0 THEN RAISE EXCEPTION 'the owner''s user id is required' USING ERRCODE = 'check_violation'; END IF;
  IF NOT (e ? 'internet_message_id') OR e->>'auth_as' IS DISTINCT FROM 'Internal' OR NOT (e ? 'auth_source') OR NOT (e ? 'auth_mechanism') THEN
    RAISE EXCEPTION 'the reply must be authenticated inside the tenant (AuthAs Internal, AuthSource, AuthMechanism) and carry its message id' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (e->>'in_reply_to' = a.request_message_id OR position(a.request_message_id IN coalesce(e->>'references', '')) > 0) THEN
    RAISE EXCEPTION 'the reply does not answer the request email (In-Reply-To / References)' USING ERRCODE = 'check_violation';
  END IF;
  IF e->>'conversation_id' IS DISTINCT FROM a.request_conversation_id THEN
    RAISE EXCEPTION 'the reply is not in the request email''s conversation' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM set_config('trusted.owner_authorization_writer', 'on', true);
  UPDATE owner_authorizations SET status = 'authorized', authorized_by_user_id = p_user_id, authorized_by_email = lower(btrim(p_email)), authorized_at = now(), evidence = e WHERE id = p_id;
  PERFORM set_config('trusted.owner_authorization_writer', 'off', true);
  RETURN jsonb_build_object('id', p_id, 'status', 'authorized');
END;
$fn$;

REVOKE ALL ON FUNCTION owner_authorization_sent(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION owner_authorization_sent(uuid, text, text) TO service_role;

COMMIT;

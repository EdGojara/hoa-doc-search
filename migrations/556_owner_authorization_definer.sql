-- ============================================================================
-- 556_owner_authorization_definer.sql  (Ed 2026-10-31)
-- ----------------------------------------------------------------------------
-- FIX for 554/555: the owner-authorization state functions UPDATE
-- owner_authorizations, but the server (service_role) holds only SELECT and
-- INSERT on that table, so the first real request failed at
-- owner_authorization_sent ("permission denied for table owner_authorizations")
-- AFTER its email had been sent. The request row was left without the email's
-- identity, so it can never be authorized.
--
--   * The four state functions run as SECURITY DEFINER (search_path pinned), so
--     they, and only they, change an authorization; service_role still has no
--     UPDATE on the table and the guard still requires the writer flag those
--     functions set.
--   * Any request that was SENT but never recorded its email identity is
--     revoked here (it cannot be authorized; a new request replaces it), with
--     the reason kept on the row.
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

ALTER FUNCTION owner_authorization_sent(uuid, text, text) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION owner_authorization_record(uuid, text, text, jsonb) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION owner_authorization_mark_executed(uuid, jsonb) SECURITY DEFINER SET search_path = public;
ALTER FUNCTION conversion_decide_object_delegated(uuid, text, uuid, text, text, text) SECURITY DEFINER SET search_path = public;

DO $m556$
DECLARE n int;
BEGIN
  PERFORM set_config('trusted.owner_authorization_writer', 'on', true);
  UPDATE owner_authorizations
     SET status = 'revoked',
         execution = jsonb_build_object('revoked_by', 'migration 556', 'reason',
           'the request email was sent but its message identity was not recorded (permission error fixed in 556); it cannot be authorized and is replaced by a new request')
   WHERE status = 'requested' AND request_message_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('trusted.owner_authorization_writer', 'off', true);
  IF n > 1 THEN RAISE EXCEPTION 'guard: % unsent requests revoked, expected at most 1', n; END IF;
  IF EXISTS (SELECT 1 FROM owner_authorizations WHERE status IN ('authorized', 'executed')) THEN RAISE EXCEPTION 'guard: an authorization was already given; review before changing these functions'; END IF;
END
$m556$;

COMMIT;

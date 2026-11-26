-- 582: Owner-authorized, agent-executed ARC/ACC decisions (Ed 2026-11-26)
--
-- Extends the Owner Authorization Service (migrations 554-556, 566, 577) to architectural
-- review: builder lot decisions, resident ACC decisions and requests for information, and
-- the correspondence that carries them. No new authorization system: the same
-- owner_authorizations table, request email from Tessa, verified reply from the owner's
-- own mailbox (exact request, AuthAs Internal, unexpired), permanent evidence and the shared
-- authorization_events ledger.
--
-- One request lists every item, numbered. Each item names its target (an ACC case, a builder
-- application, or a Draft Queue message), the action, the executing teammate and a fingerprint
-- of exactly what the owner reviewed (the decision, the conditions, the letter or message text
-- and recipients). The owner replies "approved", or "approved except 3, 7"; the excluded
-- numbers are recorded in the reply's evidence and never executed. A target that changed after
-- the request (fingerprint mismatch), or correspondence already sent or superseded, is not
-- executed.
--
-- Execution runs through each module's own path (builder finalize, ACC finalize, Draft Queue
-- send), so every module control stays in force. The decision is recorded as the owner's,
-- authorized by email reply, executed by the named teammate; never as an in-app approval.
--
-- Record ownership: association_record (the owner's authorization of the association's
-- architectural decisions, and its evidence).
BEGIN;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check
  CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions'));

-- A request of ARC/ACC items: p_items = [{ n, action, target_type, target_id, fingerprint, executor, ... }].
-- The caller computes each fingerprint from the target it verified; this function checks the shape,
-- that every target exists and is still open, and that nothing is listed twice.
CREATE OR REPLACE FUNCTION owner_authorization_request_arc_acc(p_subject text, p_summary text, p_items jsonb, p_owner_email text,
  p_requested_by text, p_coordinator text DEFAULT 'ai-team:amanda', p_tier integer DEFAULT 1, p_hours integer DEFAULT 168)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE it jsonb; n int := 0; new_id uuid; st text; tid uuid;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF p_tier IS NULL OR p_tier NOT IN (1, 2) THEN RAISE EXCEPTION 'ARC/ACC decisions are tier 1 or 2' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN RAISE EXCEPTION 'list at least one item' USING ERRCODE = 'check_violation'; END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    n := n + 1;
    IF (it->>'n') IS DISTINCT FROM n::text THEN RAISE EXCEPTION 'item % is numbered %; items are numbered 1, 2, 3 in order', n, coalesce(it->>'n', 'nothing') USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(it->>'action', '') NOT IN ('builder_decision', 'acc_decision', 'acc_info_request', 'correspondence') THEN
      RAISE EXCEPTION 'item %: unknown action %', n, coalesce(it->>'action', 'none') USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(it->>'fingerprint', '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'item %: fingerprint missing', n USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(it->>'executor', '') !~ '^ai-team:[a-z]+$' THEN RAISE EXCEPTION 'item %: the executing teammate is required', n USING ERRCODE = 'check_violation'; END IF;
    BEGIN tid := (it->>'target_id')::uuid; EXCEPTION WHEN others THEN RAISE EXCEPTION 'item %: target id is not a uuid', n USING ERRCODE = 'check_violation'; END;
    IF it->>'target_type' = 'acc_decision' THEN SELECT status INTO st FROM acc_decisions WHERE id = tid;
      IF st IS NULL OR st NOT IN ('pending_review', 'awaiting_info') THEN RAISE EXCEPTION 'item %: ACC case % is not open', n, tid USING ERRCODE = 'check_violation'; END IF;
    ELSIF it->>'target_type' = 'builder_application' THEN SELECT status INTO st FROM builder_applications WHERE id = tid;
      IF st IS NULL OR st LIKE 'approved%' OR st IN ('denied', 'withdrawn') THEN RAISE EXCEPTION 'item %: builder application % is not open', n, tid USING ERRCODE = 'check_violation'; END IF;
    ELSIF it->>'target_type' = 'outbound_email_draft' THEN SELECT status INTO st FROM outbound_email_drafts WHERE id = tid;
      IF st IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'item %: message % is not an unsent draft', n, tid USING ERRCODE = 'check_violation'; END IF;
    ELSE RAISE EXCEPTION 'item %: unknown target type %', n, coalesce(it->>'target_type', 'none') USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'target_id') FROM jsonb_array_elements(p_items) x) <> n THEN RAISE EXCEPTION 'a target is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, coordinator, sensitivity_tier)
  VALUES ('arc_acc_decisions', btrim(p_subject), p_summary, p_items, conversion_sha256_jsonb(p_items), lower(btrim(p_owner_email)), p_requested_by,
    now() + make_interval(hours => p_hours), coalesce(nullif(btrim(p_coordinator), ''), 'ai-team:amanda'), p_tier)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', n, 'items_sha256', conversion_sha256_jsonb(p_items));
END;
$fn$;

REVOKE ALL ON FUNCTION owner_authorization_request_arc_acc(text, text, jsonb, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION owner_authorization_request_arc_acc(text, text, jsonb, text, text, text, integer, integer) TO service_role;

COMMIT;

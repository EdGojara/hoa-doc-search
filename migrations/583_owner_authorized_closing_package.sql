-- 583: Owner-authorized closing packages (Ed 2026-11-27)
--
-- Extends the Owner Authorization Service (migrations 554-556, 566, 577, 582) to the closing
-- package of Ownership Review (lib/home_sales/transfer_package, PR #471): the completed builder
-- closings of one community, each transfer at its recorded settlement date, the builder and
-- buyer prorations it posts and the buyer capitalization fee. No new approval system and no
-- second package: the same owner_authorizations table, request email from Tessa, verified reply
-- from the owner's own mailbox (exact request, AuthAs Internal, unexpired), permanent evidence
-- and the shared authorization_events ledger. Execution runs the existing package workflow.
--
--   owner_authorization_request_closing_package  one request: every item is a pending transfer of
--       the community, at its proposal's settlement date, listed once, with the amounts shown and
--       the package fingerprint (what the owner saw). The executor rebuilds the package and refuses
--       if the fingerprint changed.
--   accounting_run_approve_closing_package  approves the capitalization-fee journal-entry run under
--       that authorization: authorized and unexpired, same community, every entry of the run is the
--       fee of an authorized transfer that has been completed, at exactly the authorized amount.
--
-- Record ownership: association_record (the owner's authorization of the association's ownership
-- records and receivables, and its evidence).
BEGIN;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check
  CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions', 'closing_packages'));

-- p_items = [{ n, proposal_id, community_id, property_id, address, settlement_date, buyer,
--              builder_adjustment_cents, homeowner_due_cents, capitalization_cents, fingerprint }]
CREATE OR REPLACE FUNCTION owner_authorization_request_closing_package(p_subject text, p_summary text, p_community_id uuid, p_items jsonb,
  p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE it jsonb; n int := 0; new_id uuid; p ownership_change_proposals%ROWTYPE; fp text := NULL;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'list 1 to 50 transfers' USING ERRCODE = 'check_violation'; END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    n := n + 1;
    IF (it->>'n') IS DISTINCT FROM n::text THEN RAISE EXCEPTION 'item % is numbered %; items are numbered 1, 2, 3 in order', n, coalesce(it->>'n', 'nothing') USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(it->>'fingerprint', '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'item %: package fingerprint missing', n USING ERRCODE = 'check_violation'; END IF;
    IF fp IS NOT NULL AND fp <> it->>'fingerprint' THEN RAISE EXCEPTION 'item %: every item carries the same package fingerprint', n USING ERRCODE = 'check_violation'; END IF;
    fp := it->>'fingerprint';
    IF (it->>'community_id') IS DISTINCT FROM p_community_id::text THEN RAISE EXCEPTION 'item %: another community', n USING ERRCODE = 'check_violation'; END IF;
    BEGIN SELECT * INTO p FROM ownership_change_proposals WHERE id = (it->>'proposal_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'item %: proposal id is not a uuid', n USING ERRCODE = 'check_violation'; END;
    IF NOT FOUND OR p.status <> 'pending' THEN RAISE EXCEPTION 'item %: transfer % is not pending', n, it->>'proposal_id' USING ERRCODE = 'check_violation'; END IF;
    IF p.community_id <> p_community_id OR p.property_id::text IS DISTINCT FROM it->>'property_id' THEN RAISE EXCEPTION 'item %: the transfer does not match its lot', n USING ERRCODE = 'check_violation'; END IF;
    IF p.effective_start_date::text IS DISTINCT FROM it->>'settlement_date' THEN RAISE EXCEPTION 'item %: the settlement date differs from the transfer', n USING ERRCODE = 'check_violation'; END IF;
    IF coalesce(it->>'capitalization_cents', '') !~ '^[0-9]+$' OR coalesce(it->>'builder_adjustment_cents', '') !~ '^-?[0-9]+$' OR coalesce(it->>'homeowner_due_cents', '') !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION 'item %: amounts must be whole cents', n USING ERRCODE = 'check_violation'; END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'proposal_id') FROM jsonb_array_elements(p_items) x) <> n THEN RAISE EXCEPTION 'a transfer is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, coordinator, sensitivity_tier)
  VALUES ('closing_packages', btrim(p_subject), p_summary, p_items, conversion_sha256_jsonb(p_items), lower(btrim(p_owner_email)), p_requested_by,
    now() + make_interval(hours => p_hours), 'ai-team:amanda', 1)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', n, 'items_sha256', conversion_sha256_jsonb(p_items));
END;
$fn$;

-- Approve the capitalization-fee run of an authorized closing package, atomically.
CREATE OR REPLACE FUNCTION accounting_run_approve_closing_package(p_authorization uuid, p_run_id uuid, p_agent_id text, p_agent_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE a owner_authorizations%ROWTYPE; r accounting_runs%ROWTYPE; e jsonb; item jsonb; pid text; st text; lbl text; inc jsonb := '[]'::jsonb;
BEGIN
  IF length(btrim(coalesce(p_agent_id, ''))) = 0 THEN RAISE EXCEPTION 'the executing agent is required' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO a FROM owner_authorizations WHERE id = p_authorization FOR SHARE;
  IF NOT FOUND OR a.status <> 'authorized' OR a.scope <> 'closing_packages' THEN RAISE EXCEPTION 'no authorized owner authorization of a closing package %', p_authorization USING ERRCODE = 'check_violation'; END IF;
  IF now() > a.expires_at THEN RAISE EXCEPTION 'the owner authorization expired at %', a.expires_at USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM accounting_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'prepared' OR r.process <> 'journal_entry' THEN RAISE EXCEPTION 'run % is not a prepared journal-entry run', p_run_id USING ERRCODE = 'check_violation'; END IF;
  IF r.community_id::text IS DISTINCT FROM (a.items->0->>'community_id') THEN RAISE EXCEPTION 'run % is for another community', p_run_id USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_array_length(coalesce(r.preview->'items', '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'run % has no entries', p_run_id USING ERRCODE = 'check_violation'; END IF;
  FOR e IN SELECT * FROM jsonb_array_elements(r.preview->'items') LOOP
    IF coalesce(e->>'id', '') !~ '^capfee-' THEN RAISE EXCEPTION 'entry % is not a capitalization fee of this package', e->>'id' USING ERRCODE = 'check_violation'; END IF;
    pid := substr(e->>'id', 8);
    SELECT x INTO item FROM jsonb_array_elements(a.items) x WHERE x->>'proposal_id' = pid;
    IF item IS NULL THEN RAISE EXCEPTION 'the owner did not authorize the transfer of entry %', e->>'id' USING ERRCODE = 'check_violation'; END IF;
    IF (e->>'amount_cents') IS DISTINCT FROM (item->>'capitalization_cents') OR (e->'homeowner'->>'property_id') IS DISTINCT FROM (item->>'property_id') THEN
      RAISE EXCEPTION 'entry % differs from what the owner authorized', e->>'id' USING ERRCODE = 'check_violation'; END IF;
    SELECT status INTO st FROM ownership_change_proposals WHERE id = pid::uuid;
    IF st IS DISTINCT FROM 'approved' THEN RAISE EXCEPTION 'the transfer of entry % is not completed', e->>'id' USING ERRCODE = 'check_violation'; END IF;
    inc := inc || jsonb_build_array(e->>'id');
  END LOOP;
  lbl := a.authorized_by_email || ' (authorized by email reply, owner authorization ' || a.id::text || '; executed by ' || coalesce(nullif(btrim(p_agent_label), ''), p_agent_id) || ')';
  UPDATE accounting_runs SET status = 'approved', approved_by = lbl, approved_at = now() WHERE id = p_run_id;
  INSERT INTO accounting_run_events (run_id, event, actor, detail)
  VALUES (p_run_id, 'approved', lbl, jsonb_build_object('channel', 'owner_authorization', 'authorization_id', a.id, 'scope', a.scope, 'authorized_by_user_id', a.authorized_by_user_id,
    'authorized_by_email', a.authorized_by_email, 'authorized_at', a.authorized_at, 'evidence_message_id', a.evidence->>'internet_message_id',
    'items_sha256', a.items_sha256, 'include', inc, 'executed_by', p_agent_id));
  RETURN jsonb_build_object('run_id', p_run_id, 'approver', lbl, 'include', inc, 'authorized_by_user_id', a.authorized_by_user_id,
    'authorized_by_email', a.authorized_by_email, 'authorization_id', a.id);
END;
$fn$;

REVOKE ALL ON FUNCTION owner_authorization_request_closing_package(text, text, uuid, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION accounting_run_approve_closing_package(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION owner_authorization_request_closing_package(text, text, uuid, jsonb, text, text, integer),
  accounting_run_approve_closing_package(uuid, uuid, text, text) TO service_role;

COMMIT;

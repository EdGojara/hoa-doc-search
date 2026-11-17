-- 566: Owner-authorized, agent-executed accounting runs (Ed 2026-11-17)
--
-- Extends migration 554/555/556 (owner authorization by authenticated email reply, exact-item
-- fingerprints, expiry, permanent evidence) from conversion items to Kat's accounting runs:
-- journal entries, cutoff accruals, reclassifications, bank and account reconciliations.
-- No new authorization system: the same owner_authorizations table, request email, reply
-- verification (owner mailbox, exact request, AuthAs Internal) and evidence record.
--
-- BATCH: one request lists several runs; one "approved" reply authorizes exactly those runs,
-- each with the exact items to post (include) and a fingerprint of the prepared run.
-- If a run changes after the request (refresh, edit, re-prepare), its fingerprint no longer
-- matches and it cannot be executed under that authorization.
--
-- Audit: the run is approved_by "<owner> (authorized by email reply <id>; executed by <agent>)"
-- and its 'approved' event records channel owner_authorization, the authorization id, the
-- owner's user id and email, the reply's message id and the agent that executed. Nothing is
-- recorded as an in-app approval; the in-app path (monthly_runs.assertInAppApproval) is unchanged.
--
-- Record ownership: association_record (approval evidence for the association's books).
BEGIN;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check CHECK (scope IN ('conversion_objects', 'accounting_runs'));

-- The fingerprint of a prepared run: everything the owner reviews (what posts and what is open).
CREATE OR REPLACE FUNCTION accounting_run_fingerprint(p_run uuid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT conversion_sha256_jsonb(jsonb_build_object('id', r.id, 'community_id', r.community_id, 'process', r.process,
    'period_month', r.period_month, 'preview', r.preview, 'exceptions', r.exceptions))
  FROM accounting_runs r WHERE r.id = p_run
$fn$;

-- A batch request: p_runs = [{ "run_id": uuid, "include": [item ids] }, ...]. Every run must be
-- prepared; the item list and fingerprints are built here, from the database, not by the caller.
CREATE OR REPLACE FUNCTION owner_authorization_request_runs(p_subject text, p_summary text, p_runs jsonb, p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE it jsonb; r accounting_runs%ROWTYPE; items jsonb := '[]'::jsonb; n int := 0; new_id uuid; inc jsonb;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_runs IS NULL OR jsonb_typeof(p_runs) <> 'array' OR jsonb_array_length(p_runs) = 0 THEN RAISE EXCEPTION 'list at least one run' USING ERRCODE = 'check_violation'; END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(p_runs) LOOP
    n := n + 1;
    SELECT * INTO r FROM accounting_runs WHERE id = (it->>'run_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'run %: not found', n USING ERRCODE = 'check_violation'; END IF;
    IF r.status <> 'prepared' THEN RAISE EXCEPTION 'run % (%) is %, not prepared', n, r.id, r.status USING ERRCODE = 'check_violation'; END IF;
    inc := coalesce(it->'include', '[]'::jsonb);
    IF jsonb_typeof(inc) <> 'array' THEN RAISE EXCEPTION 'run %: include must be a list of item ids', n USING ERRCODE = 'check_violation'; END IF;
    items := items || jsonb_build_array(jsonb_build_object('object_type', 'accounting_run', 'run_id', r.id::text, 'community_id', r.community_id::text,
      'process', r.process, 'period_month', r.period_month, 'fingerprint', accounting_run_fingerprint(r.id),
      'include', (SELECT coalesce(jsonb_agg(x ORDER BY x), '[]'::jsonb) FROM (SELECT DISTINCT jsonb_array_elements_text(inc) AS x) s)));
  END LOOP;
  IF (SELECT count(DISTINCT x->>'run_id') FROM jsonb_array_elements(items) x) <> n THEN RAISE EXCEPTION 'a run is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at)
  VALUES ('accounting_runs', btrim(p_subject), p_summary, items, conversion_sha256_jsonb(items), lower(btrim(p_owner_email)), p_requested_by, now() + make_interval(hours => p_hours))
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'runs', n, 'items', items, 'items_sha256', conversion_sha256_jsonb(items));
END;
$fn$;

-- Approve ONE run under an authorized request, atomically: the authorization is authorized and
-- unexpired, lists this run, the run is still prepared and unchanged (fingerprint). Records the
-- run as approved by the owner by email authorization, executed by the agent, with the evidence.
CREATE OR REPLACE FUNCTION accounting_run_approve_delegated(p_authorization uuid, p_run_id uuid, p_agent_id text, p_agent_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE a owner_authorizations%ROWTYPE; r accounting_runs%ROWTYPE; item jsonb; fp text; lbl text;
BEGIN
  IF length(btrim(coalesce(p_agent_id, ''))) = 0 THEN RAISE EXCEPTION 'the executing agent is required' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO a FROM owner_authorizations WHERE id = p_authorization FOR SHARE;
  IF NOT FOUND OR a.status <> 'authorized' OR a.scope <> 'accounting_runs' THEN RAISE EXCEPTION 'no authorized owner authorization of accounting runs %', p_authorization USING ERRCODE = 'check_violation'; END IF;
  IF now() > a.expires_at THEN RAISE EXCEPTION 'the owner authorization expired at %', a.expires_at USING ERRCODE = 'check_violation'; END IF;
  SELECT x INTO item FROM jsonb_array_elements(a.items) x WHERE x->>'run_id' = p_run_id::text;
  IF item IS NULL THEN RAISE EXCEPTION 'the owner did not authorize run %', p_run_id USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO r FROM accounting_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'prepared' THEN RAISE EXCEPTION 'run % is not prepared', p_run_id USING ERRCODE = 'check_violation'; END IF;
  fp := accounting_run_fingerprint(p_run_id);
  IF fp IS DISTINCT FROM item->>'fingerprint' THEN RAISE EXCEPTION 'run % changed after the owner authorized it (fingerprint mismatch)', p_run_id USING ERRCODE = 'check_violation'; END IF;
  lbl := a.authorized_by_email || ' (authorized by email reply, owner authorization ' || a.id::text || '; executed by ' || coalesce(nullif(btrim(p_agent_label), ''), p_agent_id) || ')';
  UPDATE accounting_runs SET status = 'approved', approved_by = lbl, approved_at = now() WHERE id = p_run_id;
  INSERT INTO accounting_run_events (run_id, event, actor, detail)
  VALUES (p_run_id, 'approved', lbl, jsonb_build_object('channel', 'owner_authorization', 'authorization_id', a.id, 'authorized_by_user_id', a.authorized_by_user_id,
    'authorized_by_email', a.authorized_by_email, 'authorized_at', a.authorized_at, 'evidence_message_id', a.evidence->>'internet_message_id',
    'items_sha256', a.items_sha256, 'fingerprint', fp, 'include', item->'include', 'executed_by', p_agent_id));
  RETURN jsonb_build_object('run_id', p_run_id, 'approver', lbl, 'include', item->'include', 'authorized_by_user_id', a.authorized_by_user_id,
    'authorized_by_email', a.authorized_by_email, 'authorization_id', a.id);
END;
$fn$;

REVOKE ALL ON FUNCTION accounting_run_fingerprint(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION owner_authorization_request_runs(text, text, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION accounting_run_approve_delegated(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION accounting_run_fingerprint(uuid), owner_authorization_request_runs(text, text, jsonb, text, text, integer),
  accounting_run_approve_delegated(uuid, uuid, text, text) TO service_role;

COMMIT;

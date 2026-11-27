-- ============================================================================
-- 585_owner_authorized_legal_reversal.sql  (Ed 2026-11-27)
-- ----------------------------------------------------------------------------
-- Extends the Owner Authorization Service (migs 554-556, 566, 577, 582, 583, 584)
-- to legal bill-back reversals. Until now the only way to reverse a posted legal
-- bill-back (legal_invoice_postings, mig 508) was the signed-in owner's
-- POST /api/legal-review/postings/:id/reverse. With this migration Kat prepares
-- the reversal, Tessa emails the owner ONE request listing each posting (property,
-- amount, the stated reason, the owner balance before and after, the GL effect),
-- the owner replies "approved", and Kat executes it through the SAME module path
-- (lib/legal/treatment.js reversePosting: reversing entry + offsetting owner
-- credit + the legal review audit event), attributed to the owner.
--
--   scope 'legal_posting_reversals'  one request of posted, unreversed postings,
--                                    each with its stated reason and the database
--                                    fingerprint of the posting.
--   legal_posting_reversal_sha256    the fingerprint, over what must not change
--                                    between request and execution: the posting's
--                                    identity, property, owner account, kind,
--                                    amount, status, its entry and owner charge,
--                                    their state, and any reversal already written.
--
-- Sensitivity tier 2 (lib/authorization/policy.js): a reversal reduces what a
-- homeowner owes on the association's books, a consequential change to a member's
-- account, like billing an assessment in reverse; it is not money movement (tier 3).
--
-- Record ownership: no new table. owner_authorizations rows stay workpaper +
-- association evidence exactly as before. No existing rows are added, removed or
-- changed.
-- ============================================================================
BEGIN;

ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check
  CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions', 'closing_packages', 'check_receipt_allocations', 'legal_posting_reversals'));

-- What the owner authorizes must still be exactly this when Kat executes it.
CREATE OR REPLACE FUNCTION legal_posting_reversal_sha256(p_posting_id uuid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT conversion_sha256_jsonb(jsonb_build_object('posting_id', p.id, 'community_id', p.community_id, 'property_id', p.property_id, 'tenure_id', p.tenure_id,
    'kind', p.kind, 'amount_cents', p.amount_cents, 'status', p.status, 'posting_date', p.posting_date,
    'journal_entry_id', p.journal_entry_id, 'journal_entry_status', (SELECT je.status FROM journal_entries je WHERE je.id = p.journal_entry_id),
    'homeowner_transaction_id', p.homeowner_transaction_id, 'owner_charge_cents', (SELECT t.amount_cents FROM homeowner_transactions t WHERE t.id = p.homeowner_transaction_id),
    'reversal_journal_entry_id', p.reversal_journal_entry_id, 'reversal_homeowner_transaction_id', p.reversal_homeowner_transaction_id, 'reversed_at', p.reversed_at))
  FROM legal_invoice_postings p WHERE p.id = p_posting_id
$fn$;

-- p_postings = [{ posting_id, reason, reversal_date? }, ...]: each must be a posted, unreversed
-- legal bill-back with a stated reason; the items and fingerprints are built here, from the database.
CREATE OR REPLACE FUNCTION owner_authorization_request_legal_reversals(p_subject text, p_summary text, p_postings jsonb, p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE x jsonb; p legal_invoice_postings%ROWTYPE; items jsonb := '[]'::jsonb; n int := 0; new_id uuid; why text; rdate date;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_postings IS NULL OR jsonb_typeof(p_postings) <> 'array' OR jsonb_array_length(p_postings) = 0 OR jsonb_array_length(p_postings) > 50 THEN RAISE EXCEPTION 'list 1 to 50 postings' USING ERRCODE = 'check_violation'; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements(p_postings) LOOP
    n := n + 1;
    IF jsonb_typeof(x) <> 'object' OR coalesce(x->>'posting_id', '') !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'posting %: posting_id is required', n USING ERRCODE = 'check_violation'; END IF;
    SELECT * INTO p FROM legal_invoice_postings WHERE id = (x->>'posting_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'posting %: not a legal posting', n USING ERRCODE = 'check_violation'; END IF;
    IF p.status <> 'posted' OR p.reversal_journal_entry_id IS NOT NULL OR p.reversal_homeowner_transaction_id IS NOT NULL OR p.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'posting %: it is %, not a posted, unreversed bill-back', n, p.status USING ERRCODE = 'check_violation'; END IF;
    why := btrim(coalesce(x->>'reason', ''));
    IF length(why) < 5 OR length(why) > 1000 THEN RAISE EXCEPTION 'posting %: state why it is being reversed (5 to 1000 characters)', n USING ERRCODE = 'check_violation'; END IF;
    rdate := NULL;
    IF coalesce(x->>'reversal_date', '') <> '' THEN
      IF (x->>'reversal_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'posting %: reversal_date must be YYYY-MM-DD', n USING ERRCODE = 'check_violation'; END IF;
      rdate := (x->>'reversal_date')::date;
      IF rdate < p.posting_date THEN RAISE EXCEPTION 'posting %: a reversal cannot be dated before the posting (%)', n, p.posting_date USING ERRCODE = 'check_violation'; END IF;
    END IF;
    items := items || jsonb_build_array(jsonb_build_object('n', n, 'object_type', 'legal_posting', 'posting_id', p.id::text, 'community_id', p.community_id::text,
      'property_id', p.property_id::text, 'tenure_id', p.tenure_id::text, 'kind', p.kind, 'amount_cents', p.amount_cents, 'posting_date', p.posting_date::text,
      'reason', why, 'reversal_date', rdate::text, 'fingerprint', legal_posting_reversal_sha256(p.id)));
  END LOOP;
  IF (SELECT count(DISTINCT y->>'posting_id') FROM jsonb_array_elements(items) y) <> n THEN RAISE EXCEPTION 'a posting is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, coordinator, executor, sensitivity_tier)
  VALUES ('legal_posting_reversals', btrim(p_subject), p_summary, items, conversion_sha256_jsonb(items), lower(btrim(p_owner_email)), p_requested_by,
    now() + make_interval(hours => p_hours), 'ai-team:amanda', 'ai-team:kat', 2)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', items, 'items_sha256', conversion_sha256_jsonb(items));
END $fn$;

REVOKE ALL ON FUNCTION legal_posting_reversal_sha256(uuid), owner_authorization_request_legal_reversals(text, text, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION legal_posting_reversal_sha256(uuid), owner_authorization_request_legal_reversals(text, text, jsonb, text, text, integer) TO service_role;

COMMIT;

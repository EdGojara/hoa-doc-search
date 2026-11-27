-- ============================================================================
-- 584_check_receipt_allocations.sql  (Ed 2026-11-28)
-- ----------------------------------------------------------------------------
-- Split allocations in Check Receipts (platform-wide). One physical check stays ONE
-- receipt (one check number, one amount, one deposit, one bank reconciliation) and may
-- carry several allocation lines:
--   owner_account  an owner account (property + tenure; a former owner's account is
--                  allowed, e.g. the seller at a closing), funded by a named party, with
--                  its purpose (assessment, capitalization fee, other, excess) and the
--                  basis in the source document (the settlement statement).
--   held           money whose funding party cannot be established: held in the
--                  community's Unidentified Receipts account (role unidentified_receipts,
--                  mig 524), never applied to anyone by guess.
-- The lines must total the check exactly. Recording posts, once:
--   ledger   one payment row per owner account, applied to that account's open charges in
--            the Tex. Prop. Code 209.0063 order (payment_application_step, mig 469); what an
--            account's lines exceed its open charges stays as that account's unapplied credit
--            (the funding party's own credit, never moved to another owner).
--   GL       one entry: Dr Undeposited Funds (the check) / Cr Homeowner AR per owner account
--            (property-tagged) / Cr Unidentified Receipts (held), lib/payments/check_receipts.
-- A single-account check is unchanged (post_check_receipt_payment, mig 514).
--
-- Also extends the Owner Authorization Service (migs 554-556, 566, 577, 582, 583): scope
-- 'check_receipt_allocations', one request of prepared receipts with the fingerprint of each
-- receipt's allocation (owner authorization by verified email reply, executed by Kat through
-- the Check Receipts recording path).
--
-- Record ownership: homeowner_check_receipt_allocations is association_record (how the
-- association applied a payment it received, and its evidence).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS homeowner_check_receipt_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id            uuid NOT NULL REFERENCES homeowner_check_receipts(id) ON DELETE RESTRICT,
  community_id          uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  line_no               integer NOT NULL CHECK (line_no > 0),
  kind                  text NOT NULL CHECK (kind IN ('owner_account', 'held')),
  property_id           uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id             uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  funding_party         text NOT NULL CHECK (funding_party IN ('seller', 'buyer', 'payer', 'third_party', 'unknown')),
  purpose               text NOT NULL CHECK (purpose IN ('assessment', 'capitalization_fee', 'other', 'excess', 'held')),
  amount_cents          bigint NOT NULL CHECK (amount_cents > 0),
  basis                 text NOT NULL CHECK (length(btrim(basis)) >= 10),
  evidence_document_id  uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  status                text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'recorded', 'superseded', 'returned')),
  homeowner_txn_id      uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  prepared_by           text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  record_ownership      text NOT NULL DEFAULT 'association_record' CHECK (record_ownership = 'association_record'),
  CHECK ((kind = 'owner_account' AND property_id IS NOT NULL AND tenure_id IS NOT NULL AND purpose <> 'held' AND funding_party <> 'unknown')
      OR (kind = 'held' AND property_id IS NULL AND tenure_id IS NULL AND purpose = 'held'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_alloc_line ON homeowner_check_receipt_allocations (receipt_id, line_no) WHERE status <> 'superseded';
CREATE INDEX IF NOT EXISTS idx_check_alloc_receipt ON homeowner_check_receipt_allocations (receipt_id);
CREATE INDEX IF NOT EXISTS idx_check_alloc_tenure ON homeowner_check_receipt_allocations (tenure_id);
COMMENT ON TABLE homeowner_check_receipt_allocations IS 'association_record: the allocation lines of one physical check across owner accounts (and a held portion). Lines total the check; recorded once with the receipt. (mig 584)';
ALTER TABLE homeowner_check_receipt_allocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON homeowner_check_receipt_allocations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON homeowner_check_receipt_allocations TO service_role;

-- One split payment row per receipt and owner account.
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_check_alloc
  ON homeowner_transactions ((raw_row_jsonb->>'check_receipt_id'), tenure_id) WHERE raw_row_jsonb->>'source' = 'check_receipt_allocation';

-- The fingerprint of a receipt's current allocation (what the owner or staff reviewed).
CREATE OR REPLACE FUNCTION check_receipt_allocation_sha256(p_receipt_id uuid) RETURNS text LANGUAGE sql STABLE AS $fn$
  SELECT conversion_sha256_jsonb(jsonb_build_object('receipt_id', r.id, 'check_number', r.check_number, 'amount_cents', r.amount_cents, 'check_date', r.check_date,
    'lines', coalesce((SELECT jsonb_agg(jsonb_build_object('n', a.line_no, 'kind', a.kind, 'property_id', a.property_id, 'tenure_id', a.tenure_id, 'funding_party', a.funding_party,
      'purpose', a.purpose, 'amount_cents', a.amount_cents, 'basis', a.basis) ORDER BY a.line_no) FROM homeowner_check_receipt_allocations a WHERE a.receipt_id = r.id AND a.status <> 'superseded'), '[]'::jsonb)))
  FROM homeowner_check_receipts r WHERE r.id = p_receipt_id
$fn$;

-- Set (or replace) the allocation of an unrecorded receipt. p_lines = [{ kind, property_id, tenure_id,
-- funding_party, purpose, amount_cents, basis, evidence_document_id }]. Validates everything; the
-- receipt's own property/tenure become the first owner line (the existing single-account fields).
CREATE OR REPLACE FUNCTION check_receipt_set_allocations(p_receipt_id uuid, p_lines jsonb, p_actor text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE rc homeowner_check_receipts%ROWTYPE; l jsonb; n int := 0; total bigint := 0; t ownership_tenures%ROWTYPE; first_prop uuid; first_ten uuid; owners int := 0;
BEGIN
  IF length(btrim(coalesce(p_actor, ''))) = 0 THEN RAISE EXCEPTION 'who prepared the allocation is required' USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO rc FROM homeowner_check_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'check receipt % not found', p_receipt_id; END IF;
  IF rc.status NOT IN ('scanned', 'matched', 'exception') THEN RAISE EXCEPTION 'this check is %; its allocation can no longer change', rc.status USING ERRCODE = 'check_violation'; END IF;
  IF rc.amount_cents IS NULL THEN RAISE EXCEPTION 'confirm the check amount first' USING ERRCODE = 'check_violation'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 OR jsonb_array_length(p_lines) > 20 THEN
    RAISE EXCEPTION 'a split allocation has 2 to 20 lines (one account is the ordinary match)' USING ERRCODE = 'check_violation'; END IF;
  UPDATE homeowner_check_receipt_allocations SET status = 'superseded', updated_at = now() WHERE receipt_id = p_receipt_id AND status = 'prepared';
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    n := n + 1;
    IF coalesce(l->>'amount_cents', '') !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'line %: amount must be a positive whole number of cents', n USING ERRCODE = 'check_violation'; END IF;
    total := total + (l->>'amount_cents')::bigint;
    IF l->>'kind' = 'owner_account' THEN
      SELECT * INTO t FROM ownership_tenures WHERE id = (l->>'tenure_id')::uuid;
      IF NOT FOUND OR t.kind <> 'owner' OR t.community_id <> rc.community_id OR t.property_id::text IS DISTINCT FROM l->>'property_id' THEN
        RAISE EXCEPTION 'line %: the owner account does not belong to that lot in this association', n USING ERRCODE = 'check_violation'; END IF;
      owners := owners + 1;
      IF first_ten IS NULL THEN first_ten := t.id; first_prop := t.property_id; END IF;
    END IF;
    INSERT INTO homeowner_check_receipt_allocations (receipt_id, community_id, line_no, kind, property_id, tenure_id, funding_party, purpose, amount_cents, basis, evidence_document_id, prepared_by)
    VALUES (p_receipt_id, rc.community_id, n, l->>'kind', nullif(l->>'property_id', '')::uuid, nullif(l->>'tenure_id', '')::uuid, l->>'funding_party', l->>'purpose',
      (l->>'amount_cents')::bigint, btrim(coalesce(l->>'basis', '')), nullif(l->>'evidence_document_id', '')::uuid, btrim(p_actor));
  END LOOP;
  IF owners = 0 THEN RAISE EXCEPTION 'at least one line applies to an owner account; a wholly unidentified check stays an exception' USING ERRCODE = 'check_violation'; END IF;
  IF total <> rc.amount_cents THEN RAISE EXCEPTION 'the lines total % cents; the check is % cents', total, rc.amount_cents USING ERRCODE = 'check_violation'; END IF;
  UPDATE homeowner_check_receipts SET property_id = first_prop, tenure_id = first_ten, updated_at = now() WHERE id = p_receipt_id;
  RETURN jsonb_build_object('lines', n, 'total_cents', total, 'allocation_sha256', check_receipt_allocation_sha256(p_receipt_id));
END $fn$;

-- Ledger posting of a split receipt (draft batch until the GL entry posts; idempotent per receipt).
CREATE OR REPLACE FUNCTION post_check_receipt_split(p_receipt_id uuid, p_approved_by text, p_dry_run boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  rc homeowner_check_receipts%ROWTYPE; g record; r record; t ownership_tenures%ROWTYPE; prop properties%ROWTYPE;
  remaining bigint; applied bigint; a bigint; plan jsonb; groups jsonb := '[]'::jsonb; held bigint := 0; total bigint := 0;
  batch_id uuid; txn_id uuid; contact uuid; mc uuid; idx int := 0; existing int;
BEGIN
  SELECT * INTO rc FROM homeowner_check_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'check receipt % not found', p_receipt_id; END IF;
  SELECT count(*) INTO existing FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'check_receipt_allocation' AND raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text;
  IF existing > 0 THEN
    RETURN jsonb_build_object('already_posted', true, 'batch_id', (SELECT source_batch_id FROM homeowner_transactions WHERE raw_row_jsonb->>'source' = 'check_receipt_allocation' AND raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text LIMIT 1));
  END IF;
  IF rc.status <> 'matched' THEN RAISE EXCEPTION 'check receipt % is %, not matched; it cannot be recorded', p_receipt_id, rc.status; END IF;
  IF rc.check_date IS NULL OR coalesce(btrim(rc.check_number), '') = '' THEN RAISE EXCEPTION 'check number and date required'; END IF;
  IF rc.check_date > rc.received_date THEN RAISE EXCEPTION 'check % is post-dated (%)', rc.check_number, rc.check_date; END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO total FROM homeowner_check_receipt_allocations WHERE receipt_id = p_receipt_id AND status = 'prepared';
  IF total <> rc.amount_cents THEN RAISE EXCEPTION 'the allocation totals % cents; the check is % cents', total, rc.amount_cents; END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO held FROM homeowner_check_receipt_allocations WHERE receipt_id = p_receipt_id AND status = 'prepared' AND kind = 'held';

  IF NOT p_dry_run THEN
    SELECT management_company_id INTO mc FROM communities WHERE id = rc.community_id;
    INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
        row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
    VALUES (mc, rc.community_id, 'Check ' || btrim(rc.check_number) || ' (split)', rc.received_date, 'manual', 'draft',
        0, 0, 0, rc.amount_cents - held, rc.received_date, rc.received_date, 'check_receipt',
        'Scanned check split across owner accounts by its allocation, each applied per Tex. Prop. Code 209.0063; confirmed by ' || coalesce(p_approved_by, '?') || '. Committed only after its GL entry posts.')
    RETURNING id INTO batch_id;
  END IF;

  FOR g IN SELECT tenure_id, property_id, sum(amount_cents) AS amount_cents, string_agg(DISTINCT funding_party, ', ') AS parties
             FROM homeowner_check_receipt_allocations WHERE receipt_id = p_receipt_id AND status = 'prepared' AND kind = 'owner_account'
            GROUP BY tenure_id, property_id ORDER BY min(line_no) LOOP
    idx := idx + 1; remaining := g.amount_cents; applied := 0; plan := '[]'::jsonb;
    SELECT * INTO t FROM ownership_tenures WHERE id = g.tenure_id;
    FOR r IN
      WITH ch AS (
        SELECT h.id, h.transaction_date, h.charge_category, h.description,
               h.amount_cents - coalesce((SELECT sum(ap.applied_cents) FROM homeowner_txn_applications ap
                                            JOIN homeowner_transactions pp ON pp.id = ap.payment_txn_id
                                            JOIN transaction_upload_batches pb ON pb.id = pp.source_batch_id AND pb.status <> 'reverted'
                                           WHERE ap.charge_txn_id = h.id), 0) AS open_cents
          FROM homeowner_transactions h
          JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
         WHERE h.tenure_id = g.tenure_id AND h.amount_cents > 0 AND h.reverses_txn_id IS NULL
      )
      SELECT ch.*, payment_application_step(ch.charge_category, ch.transaction_date, rc.received_date) AS step
        FROM ch WHERE open_cents > 0 AND payment_application_step(ch.charge_category, ch.transaction_date, rc.received_date) IS NOT NULL
       ORDER BY step, transaction_date, id
    LOOP
      CONTINUE WHEN remaining <= 0;
      a := least(remaining, r.open_cents); remaining := remaining - a; applied := applied + a;
      plan := plan || jsonb_build_object('charge_txn_id', r.id, 'date', r.transaction_date, 'category', r.charge_category, 'description', r.description,
                                         'step', r.step, 'open_before_cents', r.open_cents, 'applied_cents', a);
    END LOOP;
    txn_id := NULL;
    IF NOT p_dry_run THEN
      SELECT * INTO prop FROM properties WHERE id = g.property_id;
      SELECT contact_id INTO contact FROM property_ownerships WHERE tenure_id = g.tenure_id ORDER BY is_primary DESC, start_date, id LIMIT 1;
      INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
          property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, reduction_source, raw_row_jsonb)
      VALUES (batch_id, idx, rc.community_id, t.vantaca_account_id, prop.trusted_account_number, g.property_id, contact, g.tenure_id, rc.received_date,
          'Check #' || btrim(rc.check_number) || coalesce(' from ' || nullif(btrim(rc.payer_name), ''), '') || ' (' || g.parties || ' share)',
          'payment', 'payment', -g.amount_cents, 'cash_payment',
          jsonb_build_object('source', 'check_receipt_allocation', 'check_receipt_id', rc.id, 'check_number', btrim(rc.check_number), 'payer', rc.payer_name,
                             'funding_parties', g.parties, 'check_amount_cents', rc.amount_cents, 'check_date', rc.check_date, 'front_document_id', rc.front_document_id))
      RETURNING id INTO txn_id;
      INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis,
          applied_as_of, method, run_id, approved_by)
      SELECT rc.community_id, g.tenure_id, txn_id, (x->>'charge_txn_id')::uuid, (x->>'applied_cents')::bigint, (x->>'step')::smallint,
             CASE (x->>'step')::int WHEN 1 THEN 'delinquent_assessment' WHEN 2 THEN 'current_assessment' WHEN 3 THEN 'attorney_fee_assessment'
                                    WHEN 4 THEN 'attorney_fee_other' WHEN 5 THEN 'fine' ELSE 'other' END,
             rc.received_date, 'auto_209_0063', batch_id, p_approved_by
        FROM jsonb_array_elements(plan) x WHERE (x->>'applied_cents')::bigint > 0;
    END IF;
    groups := groups || jsonb_build_object('tenure_id', g.tenure_id, 'property_id', g.property_id, 'funding_parties', g.parties, 'amount_cents', g.amount_cents,
      'applied_cents', applied, 'unapplied_cents', remaining, 'applications', plan, 'payment_txn_id', txn_id);
  END LOOP;
  IF NOT p_dry_run THEN UPDATE transaction_upload_batches SET row_count = idx, account_count = idx WHERE id = batch_id; END IF;
  RETURN jsonb_build_object('dry_run', p_dry_run, 'already_posted', false, 'amount_cents', rc.amount_cents, 'held_cents', held, 'accounts', groups, 'batch_id', batch_id);
END $fn$;

-- Commit a recorded receipt after its GL entry posts: single-account (mig 514) or split.
CREATE OR REPLACE FUNCTION check_receipt_commit_posting(p_receipt_id uuid, p_journal_entry_id uuid, p_confirmed_by text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rc homeowner_check_receipts%ROWTYPE; txn record;
BEGIN
  SELECT * INTO rc FROM homeowner_check_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'check receipt % not found', p_receipt_id; END IF;
  IF rc.status IN ('recorded', 'deposited', 'reconciled', 'returned') THEN RETURN jsonb_build_object('already_committed', true); END IF;
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = p_journal_entry_id AND community_id = rc.community_id AND status = 'posted'
                   AND source_reference = 'checkrcpt:' || p_receipt_id::text) THEN
    RAISE EXCEPTION 'journal entry % is not this receipt''s posted entry', p_journal_entry_id;
  END IF;
  SELECT h.id, h.source_batch_id INTO txn FROM homeowner_transactions h
   WHERE h.raw_row_jsonb->>'source' IN ('check_receipt', 'check_receipt_allocation') AND h.raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text
   ORDER BY h.source_row_index LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'no ledger row for check receipt %', p_receipt_id; END IF;
  UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = txn.source_batch_id AND status = 'draft';
  UPDATE homeowner_check_receipt_allocations a SET status = 'recorded', updated_at = now(),
         homeowner_txn_id = (SELECT h.id FROM homeowner_transactions h WHERE h.raw_row_jsonb->>'source' = 'check_receipt_allocation'
                               AND h.raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text AND h.tenure_id = a.tenure_id)
   WHERE a.receipt_id = p_receipt_id AND a.status = 'prepared';
  UPDATE homeowner_check_receipts SET status = 'recorded', homeowner_txn_id = txn.id, ledger_batch_id = txn.source_batch_id,
         journal_entry_id = p_journal_entry_id, confirmed_by = coalesce(confirmed_by, p_confirmed_by), confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
   WHERE id = p_receipt_id;
  RETURN jsonb_build_object('already_committed', false, 'homeowner_txn_id', txn.id, 'batch_id', txn.source_batch_id);
END $$;

-- Owner Authorization Service: scope check_receipt_allocations.
ALTER TABLE owner_authorizations DROP CONSTRAINT IF EXISTS owner_authorizations_scope_check;
ALTER TABLE owner_authorizations ADD CONSTRAINT owner_authorizations_scope_check
  CHECK (scope IN ('conversion_objects', 'accounting_runs', 'arc_acc_decisions', 'closing_packages', 'check_receipt_allocations'));

-- p_receipts = [uuid, ...]: each must be matched with a prepared split allocation; the items and
-- fingerprints are built here, from the database.
CREATE OR REPLACE FUNCTION owner_authorization_request_check_allocations(p_subject text, p_summary text, p_receipts jsonb, p_owner_email text, p_requested_by text, p_hours integer DEFAULT 72)
RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE x text; rc homeowner_check_receipts%ROWTYPE; items jsonb := '[]'::jsonb; n int := 0; new_id uuid;
BEGIN
  IF p_hours IS NULL OR p_hours < 1 OR p_hours > 168 THEN RAISE EXCEPTION 'an authorization request expires within 1 to 168 hours' USING ERRCODE = 'check_violation'; END IF;
  IF length(btrim(coalesce(p_owner_email, ''))) < 3 THEN RAISE EXCEPTION 'the owner email is required' USING ERRCODE = 'check_violation'; END IF;
  IF p_receipts IS NULL OR jsonb_typeof(p_receipts) <> 'array' OR jsonb_array_length(p_receipts) = 0 OR jsonb_array_length(p_receipts) > 50 THEN RAISE EXCEPTION 'list 1 to 50 checks' USING ERRCODE = 'check_violation'; END IF;
  FOR x IN SELECT * FROM jsonb_array_elements_text(p_receipts) LOOP
    n := n + 1;
    SELECT * INTO rc FROM homeowner_check_receipts WHERE id = x::uuid;
    IF NOT FOUND OR rc.status <> 'matched' THEN RAISE EXCEPTION 'check %: not a matched receipt', n USING ERRCODE = 'check_violation'; END IF;
    IF (SELECT coalesce(sum(amount_cents), 0) FROM homeowner_check_receipt_allocations WHERE receipt_id = rc.id AND status = 'prepared') <> rc.amount_cents THEN
      RAISE EXCEPTION 'check %: its allocation does not total the check', n USING ERRCODE = 'check_violation'; END IF;
    items := items || jsonb_build_array(jsonb_build_object('n', n, 'object_type', 'check_receipt', 'receipt_id', rc.id::text, 'community_id', rc.community_id::text,
      'check_number', rc.check_number, 'amount_cents', rc.amount_cents, 'fingerprint', check_receipt_allocation_sha256(rc.id)));
  END LOOP;
  IF (SELECT count(DISTINCT y->>'receipt_id') FROM jsonb_array_elements(items) y) <> n THEN RAISE EXCEPTION 'a check is listed twice' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO owner_authorizations (scope, subject, summary, items, items_sha256, owner_email, requested_by, expires_at, coordinator, sensitivity_tier)
  VALUES ('check_receipt_allocations', btrim(p_subject), p_summary, items, conversion_sha256_jsonb(items), lower(btrim(p_owner_email)), p_requested_by,
    now() + make_interval(hours => p_hours), 'ai-team:amanda', 1)
  RETURNING id INTO new_id;
  RETURN jsonb_build_object('id', new_id, 'items', items, 'items_sha256', conversion_sha256_jsonb(items));
END $fn$;

REVOKE ALL ON FUNCTION check_receipt_allocation_sha256(uuid), check_receipt_set_allocations(uuid, jsonb, text), post_check_receipt_split(uuid, text, boolean),
  owner_authorization_request_check_allocations(text, text, jsonb, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_receipt_allocation_sha256(uuid), check_receipt_set_allocations(uuid, jsonb, text), post_check_receipt_split(uuid, text, boolean),
  owner_authorization_request_check_allocations(text, text, jsonb, text, text, integer) TO service_role;

COMMIT;

-- ============================================================================
-- 514_homeowner_check_receipts.sql  (Ed 2026-10-12)
-- ----------------------------------------------------------------------------
-- Scanned homeowner checks, recorded once, deposited, reconciled.
--
-- Reuses what exists; builds no parallel ledger:
--   * the homeowner ledger (homeowner_transactions + homeowner_txn_applications,
--     migs 195/461/469) and the Tex. Prop. Code 209.0063 application order
--     (payment_application_step, mig 469);
--   * GL through lib/accounting/posting.js postJournalEntry (period + cutover guards);
--   * community_account_roles (mig 469) for the accounts, never hard-coded numbers;
--   * library_documents for the check images.
--
-- Accounting (adapted to the existing architecture):
--   check recorded   Dr Undeposited Funds (role undeposited_funds) / Cr Homeowner AR
--   bank deposit     Dr Operating Cash (role operating_cash)       / Cr Undeposited Funds
--   returned check   Dr Homeowner AR / Cr Operating Cash (or Undeposited Funds if it
--                    was never deposited), with a dated reversal row on the ledger.
-- Scanning a check is never proof the bank accepted it: cash moves only when staff
-- record the bank's remote-deposit confirmation.
--
-- Record ownership:
--   homeowner_check_receipts  association_record (the receipt, images, posting refs)
--   homeowner_check_deposits  association_record (deposit confirmation, bank match)
-- Nothing existing is changed except: the account-role CHECK gains
-- 'undeposited_funds', and an Undeposited Funds account (1020, beside Operating
-- Cash, same fund) is added where a community has none. No balance moves.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Undeposited Funds account + role
-- ---------------------------------------------------------------------------
ALTER TABLE community_account_roles DROP CONSTRAINT IF EXISTS community_account_roles_role_check;
ALTER TABLE community_account_roles ADD CONSTRAINT community_account_roles_role_check
  CHECK (role IN ('operating_cash', 'stripe_clearing', 'homeowner_ar', 'undeposited_funds'));

INSERT INTO chart_of_accounts (community_id, fund_id, account_number, account_name, account_type, account_subtype,
                               normal_balance, is_summary, is_active, description)
SELECT c.community_id, c.fund_id, '1020', 'Undeposited Funds', 'asset', c.account_subtype, 'debit', false, true,
       'Homeowner checks received and recorded, not yet confirmed deposited at the bank. Not cash in the bank. Check: Dr this / Cr AR. Deposit: Dr operating cash / Cr this. (mig 514)'
  FROM chart_of_accounts c
 WHERE c.account_number = '1000' AND c.is_active AND NOT c.is_summary
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = c.community_id AND x.account_number = '1020')
   AND NOT EXISTS (SELECT 1 FROM chart_of_accounts x WHERE x.community_id = c.community_id AND x.account_name ILIKE '%undeposited%');

-- The role points at the community's Undeposited Funds account (an existing one wins).
INSERT INTO community_account_roles (community_id, role, account_id, updated_by)
SELECT DISTINCT ON (a.community_id) a.community_id, 'undeposited_funds', a.id, 'migration 514'
  FROM chart_of_accounts a
 WHERE a.account_name ILIKE '%undeposited%' AND a.is_active AND NOT a.is_summary AND a.account_type = 'asset' AND a.normal_balance = 'debit'
 ORDER BY a.community_id, (a.account_number = '1020') DESC, a.account_number
ON CONFLICT (community_id, role) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Deposits (the bank's remote-deposit confirmation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homeowner_check_deposits (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id                  uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  status                        text NOT NULL DEFAULT 'deposited' CHECK (status IN ('deposited', 'reconciled', 'voided')),
  deposit_date                  date NOT NULL,
  bank_reference                text NOT NULL CHECK (btrim(bank_reference) <> ''),
  cash_account_id               uuid NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  total_cents                   bigint NOT NULL CHECK (total_cents > 0),
  check_count                   integer NOT NULL CHECK (check_count > 0),
  evidence_document_id          uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  journal_entry_id              uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  bank_statement_transaction_id uuid REFERENCES bank_statement_transactions(id) ON DELETE RESTRICT,
  reconciled_at                 timestamptz,
  reconciled_by                 text,
  notes                         text,
  created_by                    text NOT NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  record_ownership              text NOT NULL DEFAULT 'association_record' CHECK (record_ownership = 'association_record'),
  UNIQUE (community_id, bank_reference)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_deposit_bank_line ON homeowner_check_deposits (bank_statement_transaction_id) WHERE bank_statement_transaction_id IS NOT NULL;
COMMENT ON TABLE homeowner_check_deposits IS 'association_record: a confirmed bank (remote) deposit of recorded homeowner checks. Posting: Dr operating cash / Cr Undeposited Funds, source_reference chkdep:<id>. (mig 514)';

-- ---------------------------------------------------------------------------
-- 3) Check receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS homeowner_check_receipts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id             uuid NOT NULL REFERENCES communities(id) ON DELETE RESTRICT,
  scan_batch_id            uuid NOT NULL,
  status                   text NOT NULL DEFAULT 'scanned'
                           CHECK (status IN ('scanned', 'matched', 'recorded', 'deposited', 'reconciled', 'returned', 'exception', 'voided')),
  exception_reason         text,
  -- images (front required, back when scanned)
  front_document_id        uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  back_document_id         uuid REFERENCES library_documents(id) ON DELETE RESTRICT,
  front_sha256             text NOT NULL,
  back_sha256              text,
  -- what the check says (extracted, then staff-confirmed)
  check_number             text,
  amount_cents             bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  check_date               date,
  received_date            date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Chicago')::date),   -- the payment date on the ledger (the date the association received it)
  payer_name               text,
  payer_address            text,
  payee_name               text,
  memo                     text,
  written_account_number   text,
  routing_number           text,
  account_last4            text,     -- never the full bank account number
  micr_fingerprint         text,     -- sha256(routing|account|check#): duplicate detection without storing the account
  extracted                jsonb,    -- raw model output
  -- the match
  property_id              uuid REFERENCES properties(id) ON DELETE RESTRICT,
  tenure_id                uuid REFERENCES ownership_tenures(id) ON DELETE RESTRICT,
  match_confidence         text CHECK (match_confidence IS NULL OR match_confidence IN ('high', 'medium', 'low', 'none')),
  match_evidence           jsonb,
  match_candidates         jsonb,
  duplicate_findings       jsonb,
  override_note            text,     -- staff reason when recording past a possible-duplicate finding
  -- posting
  confirmed_by             text,
  confirmed_at             timestamptz,
  homeowner_txn_id         uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  ledger_batch_id          uuid,
  journal_entry_id         uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  deposit_id               uuid REFERENCES homeowner_check_deposits(id) ON DELETE RESTRICT,
  -- returned / voided
  returned_at              timestamptz,
  return_reason            text,
  return_txn_id            uuid REFERENCES homeowner_transactions(id) ON DELETE RESTRICT,
  return_journal_entry_id  uuid REFERENCES journal_entries(id) ON DELETE RESTRICT,
  created_by               text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  record_ownership         text NOT NULL DEFAULT 'association_record' CHECK (record_ownership = 'association_record'),
  CHECK (status NOT IN ('recorded', 'deposited', 'reconciled', 'returned') OR (homeowner_txn_id IS NOT NULL AND journal_entry_id IS NOT NULL)),
  CHECK (status NOT IN ('deposited', 'reconciled') OR deposit_id IS NOT NULL)
);
-- Duplicate guards. The same image, or the same check (routing + account + number), is
-- one receipt. A returned check may legitimately be re-presented, so returned and voided
-- receipts do not block a new one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_receipt_front_image ON homeowner_check_receipts (front_sha256) WHERE status NOT IN ('voided', 'returned');
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_receipt_micr ON homeowner_check_receipts (community_id, micr_fingerprint) WHERE micr_fingerprint IS NOT NULL AND status NOT IN ('voided', 'returned');
CREATE INDEX IF NOT EXISTS idx_check_receipts_status ON homeowner_check_receipts (community_id, status);
CREATE INDEX IF NOT EXISTS idx_check_receipts_property ON homeowner_check_receipts (property_id);
CREATE INDEX IF NOT EXISTS idx_check_receipts_deposit ON homeowner_check_receipts (deposit_id);
COMMENT ON TABLE homeowner_check_receipts IS 'association_record: a scanned homeowner check. Scanned -> matched (staff confirm) -> recorded (ledger + Dr Undeposited / Cr AR) -> deposited (bank confirmation) -> reconciled (bank line). Returned / exception / voided. (mig 514)';

-- One ledger row per receipt; one GL entry per receipt, deposit and return.
CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_check_receipt
  ON homeowner_transactions ((raw_row_jsonb->>'check_receipt_id')) WHERE raw_row_jsonb->>'source' = 'check_receipt';
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_check_refs ON journal_entries (community_id, source_reference)
  WHERE source_reference LIKE 'checkrcpt:%' OR source_reference LIKE 'chkdep:%' OR source_reference LIKE 'checkret:%';

ALTER TABLE homeowner_check_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE homeowner_check_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON homeowner_check_receipts, homeowner_check_deposits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON homeowner_check_receipts, homeowner_check_deposits TO service_role;

-- ---------------------------------------------------------------------------
-- 4) Ledger posting (draft batch until the GL entry posts; idempotent per receipt)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION post_check_receipt_payment(p_receipt_id uuid, p_approved_by text, p_dry_run boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rc homeowner_check_receipts%ROWTYPE; t ownership_tenures%ROWTYPE; prop properties%ROWTYPE; existing record;
  remaining bigint; applied bigint := 0; a bigint; r record; batch_id uuid; txn_id uuid; contact uuid; mc uuid; n int := 0;
  plan jsonb := '[]'::jsonb; total_open bigint := 0;
BEGIN
  SELECT * INTO rc FROM homeowner_check_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'check receipt % not found', p_receipt_id; END IF;

  SELECT h.id, h.source_batch_id, b.status INTO existing FROM homeowner_transactions h
    JOIN transaction_upload_batches b ON b.id = h.source_batch_id
   WHERE h.raw_row_jsonb->>'source' = 'check_receipt' AND h.raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text;
  IF FOUND THEN
    IF existing.status = 'reverted' THEN RAISE EXCEPTION 'check receipt % was posted and later reverted; handle manually', p_receipt_id; END IF;
    RETURN jsonb_build_object('already_posted', true, 'payment_txn_id', existing.id, 'batch_id', existing.source_batch_id, 'batch_status', existing.status);
  END IF;

  IF rc.status <> 'matched' THEN RAISE EXCEPTION 'check receipt % is %, not matched; it cannot be recorded', p_receipt_id, rc.status; END IF;
  IF rc.amount_cents IS NULL OR rc.amount_cents <= 0 THEN RAISE EXCEPTION 'check amount required'; END IF;
  IF rc.check_date IS NULL THEN RAISE EXCEPTION 'check date required'; END IF;
  IF rc.check_date > rc.received_date THEN RAISE EXCEPTION 'check % is post-dated (%); it cannot be recorded before that date', rc.check_number, rc.check_date; END IF;
  IF coalesce(btrim(rc.check_number), '') = '' THEN RAISE EXCEPTION 'check number required'; END IF;
  SELECT * INTO t FROM ownership_tenures WHERE id = rc.tenure_id;
  IF NOT FOUND OR t.kind <> 'owner' OR t.property_id IS DISTINCT FROM rc.property_id OR t.community_id <> rc.community_id THEN
    RAISE EXCEPTION 'the matched owner tenure does not belong to this property/community';
  END IF;
  SELECT * INTO prop FROM properties WHERE id = rc.property_id;

  remaining := rc.amount_cents;
  FOR r IN
    WITH ch AS (
      SELECT h.id, h.transaction_date, h.charge_category, h.description,
             h.amount_cents - coalesce((SELECT sum(ap.applied_cents) FROM homeowner_txn_applications ap
                                          JOIN homeowner_transactions pp ON pp.id = ap.payment_txn_id
                                          JOIN transaction_upload_batches pb ON pb.id = pp.source_batch_id AND pb.status <> 'reverted'
                                         WHERE ap.charge_txn_id = h.id), 0) AS open_cents
        FROM homeowner_transactions h
        JOIN transaction_upload_batches b ON b.id = h.source_batch_id AND b.status = 'committed'
       WHERE h.tenure_id = rc.tenure_id AND h.amount_cents > 0 AND h.reverses_txn_id IS NULL
    )
    SELECT ch.*, payment_application_step(ch.charge_category, ch.transaction_date, rc.received_date) AS step
      FROM ch WHERE open_cents > 0 AND payment_application_step(ch.charge_category, ch.transaction_date, rc.received_date) IS NOT NULL
     ORDER BY step, transaction_date, id
  LOOP
    total_open := total_open + r.open_cents;
    CONTINUE WHEN remaining <= 0;
    a := least(remaining, r.open_cents);
    remaining := remaining - a; applied := applied + a;
    plan := plan || jsonb_build_object('charge_txn_id', r.id, 'date', r.transaction_date, 'category', r.charge_category, 'description', r.description,
                                       'step', r.step, 'open_before_cents', r.open_cents, 'applied_cents', a);
  END LOOP;

  IF p_dry_run THEN
    RETURN jsonb_build_object('dry_run', true, 'amount_cents', rc.amount_cents, 'applied_cents', applied, 'unapplied_cents', remaining,
      'open_before_cents', total_open, 'applications', plan, 'tenure_id', rc.tenure_id);
  END IF;

  SELECT management_company_id INTO mc FROM communities WHERE id = rc.community_id;
  SELECT contact_id INTO contact FROM property_ownerships WHERE tenure_id = rc.tenure_id ORDER BY is_primary DESC, start_date, id LIMIT 1;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status,
      row_count, account_count, total_charges_cents, total_payments_cents, min_transaction_date, max_transaction_date, uploaded_by, notes)
  VALUES (mc, rc.community_id, 'Check ' || btrim(rc.check_number), rc.received_date, 'manual', 'draft',
      1, 1, 0, rc.amount_cents, rc.received_date, rc.received_date, 'check_receipt',
      'Scanned homeowner check, applied per Tex. Prop. Code 209.0063; confirmed by ' || coalesce(p_approved_by, '?') || '. Committed only after its GL entry posts.')
  RETURNING id INTO batch_id;
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, vantaca_account_id, trusted_account_number,
      property_id, contact_id, tenure_id, transaction_date, description, txn_type, charge_category, amount_cents, reduction_source, raw_row_jsonb)
  VALUES (batch_id, 1, rc.community_id, t.vantaca_account_id, prop.trusted_account_number, rc.property_id, contact, rc.tenure_id, rc.received_date,
      'Check #' || btrim(rc.check_number) || coalesce(' from ' || nullif(btrim(rc.payer_name), ''), ''),
      'payment', 'payment', -rc.amount_cents, 'cash_payment',
      jsonb_build_object('source', 'check_receipt', 'check_receipt_id', rc.id, 'check_number', btrim(rc.check_number), 'payer', rc.payer_name,
                         'check_date', rc.check_date, 'front_document_id', rc.front_document_id, 'back_document_id', rc.back_document_id))
  RETURNING id INTO txn_id;
  INSERT INTO homeowner_txn_applications (community_id, tenure_id, payment_txn_id, charge_txn_id, applied_cents, priority_step, priority_basis,
      applied_as_of, method, run_id, approved_by)
  SELECT rc.community_id, rc.tenure_id, txn_id, (x->>'charge_txn_id')::uuid, (x->>'applied_cents')::bigint, (x->>'step')::smallint,
         CASE (x->>'step')::int WHEN 1 THEN 'delinquent_assessment' WHEN 2 THEN 'current_assessment' WHEN 3 THEN 'attorney_fee_assessment'
                                WHEN 4 THEN 'attorney_fee_other' WHEN 5 THEN 'fine' ELSE 'other' END,
         rc.received_date, 'auto_209_0063', batch_id, p_approved_by
    FROM jsonb_array_elements(plan) x WHERE (x->>'applied_cents')::bigint > 0;
  GET DIAGNOSTICS n = ROW_COUNT;

  RETURN jsonb_build_object('already_posted', false, 'payment_txn_id', txn_id, 'batch_id', batch_id, 'batch_status', 'draft',
    'applied_cents', applied, 'unapplied_cents', remaining, 'applications_written', n, 'tenure_id', rc.tenure_id);
END $$;

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
   WHERE h.raw_row_jsonb->>'source' = 'check_receipt' AND h.raw_row_jsonb->>'check_receipt_id' = p_receipt_id::text;
  IF NOT FOUND THEN RAISE EXCEPTION 'no ledger row for check receipt %', p_receipt_id; END IF;
  UPDATE transaction_upload_batches SET status = 'committed', committed_at = now() WHERE id = txn.source_batch_id AND status = 'draft';
  UPDATE homeowner_check_receipts SET status = 'recorded', homeowner_txn_id = txn.id, ledger_batch_id = txn.source_batch_id,
         journal_entry_id = p_journal_entry_id, confirmed_by = coalesce(confirmed_by, p_confirmed_by), confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
   WHERE id = p_receipt_id;
  RETURN jsonb_build_object('already_committed', false, 'homeowner_txn_id', txn.id, 'batch_id', txn.source_batch_id);
END $$;

REVOKE ALL ON FUNCTION post_check_receipt_payment(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION check_receipt_commit_posting(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION post_check_receipt_payment(uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION check_receipt_commit_posting(uuid, uuid, text) TO service_role;

COMMIT;

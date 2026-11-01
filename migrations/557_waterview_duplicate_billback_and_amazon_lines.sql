-- ============================================================================
-- 557_waterview_duplicate_billback_and_amazon_lines.sql  (Ed 2026-11-01)
-- ----------------------------------------------------------------------------
-- Two Waterview post-cutover corrections, applied by the owner through
-- Approve & Apply (the authorization and its audit record). Nothing else.
--
-- A. Duplicate legal bill-back, $42.00 (JE-2026-00232, 8/31/2026).
--    Vantaca charged this attorney invoice (PS-INV343615) to the homeowner on
--    6/26/2026; it is in the 7/31 opening AR. trustEd's 8/31 reclass entry
--    (Dr 1300 / Cr 5870) and its homeowner charge are a second copy. This is
--    the same treatment Legal Review's Reverse gives a bill-back
--    (lib/legal/treatment.js reversePosting), which this charge predates:
--      * a reversal entry on the original date (8/31, after the 7/31 cutoff),
--        lines swapped, linked by reverses_je_id; the original is voided and
--        names its reversal (the 529 guard's rule);
--      * an offsetting homeowner credit of -$42.00 against the duplicate trustEd
--        charge (the same row shape as Legal Review's offsetOwnerCharge), never
--        against the Vantaca receivable.
--    Both originals stay. GL 1300 and the homeowner ledger both fall by $42.00
--    together, in one transaction.
--
-- B. Amazon order 112-0467422-8439405 (AP invoice, unposted, awaiting approval).
--    The receipt totals $34.04 and the invoice header is right; two lines were
--    mis-extracted: the napkins line holds the unit price ($4.99) for 3 packs
--    ($14.97), and the $2.59 tax was entered as a line as well as in the header.
--    Lines become 14.97 + 9.49 + 6.99 = 31.45 = total - tax, so the bill can post
--    through the normal AP path. No journal entry is written here.
-- Record ownership: association_record.
-- ============================================================================
BEGIN;

DO $m557$
DECLARE
  c        constant uuid := 'a0000000-0000-4000-8000-000000000001';
  orig_id  constant uuid := '663d14c0-76d7-4cf8-bed6-4985aa2a6c96';
  dup_id   constant uuid := 'cd62c4c7-9db8-43f5-9664-05f981e9a40f';
  inv_id   constant uuid := '33fbabb2-2c62-4df0-af72-a55054e058e9';
  o        journal_entries%ROWTYPE;
  h        homeowner_transactions%ROWTYPE;
  per      accounting_periods%ROWTYPE;
  rev_id   uuid;
  batch_id uuid;
  bal      bigint;
  n        int;
  why      constant text := 'Duplicate of the 6/26/2026 Vantaca charge (PS-INV343615) already in the 7/31 opening AR; reversed by migration 557, authorized by the owner through Approve & Apply';
BEGIN
  -- ---------------------------------------------------------------- A. guards
  SELECT * INTO o FROM journal_entries WHERE id = orig_id FOR UPDATE;
  IF NOT FOUND OR o.community_id <> c OR o.status <> 'posted' OR o.posting_date <> DATE '2026-08-31'
     OR o.total_debits_cents <> 4200 OR o.total_credits_cents <> 4200 OR o.reference <> 'JE-2026-00232' THEN
    RAISE EXCEPTION 'guard: JE-2026-00232 is not the posted $42.00 entry of 8/31/2026';
  END IF;
  SELECT count(*) INTO n FROM journal_entry_lines WHERE journal_entry_id = orig_id;
  IF n <> 2 THEN RAISE EXCEPTION 'guard: JE-2026-00232 has % lines, expected 2', n; END IF;
  IF EXISTS (SELECT 1 FROM journal_entries WHERE reverses_je_id = orig_id) THEN
    RAISE EXCEPTION 'guard: JE-2026-00232 already has a reversal';
  END IF;
  SELECT * INTO h FROM homeowner_transactions WHERE id = dup_id FOR UPDATE;
  IF NOT FOUND OR h.community_id <> c OR h.amount_cents <> 4200 OR h.txn_type <> 'charge' OR h.vantaca_account_id <> '10111113'
     OR h.transaction_date <> DATE '2026-08-31' THEN
    RAISE EXCEPTION 'guard: the duplicate $42.00 homeowner charge is not as reviewed';
  END IF;
  IF EXISTS (SELECT 1 FROM homeowner_transactions WHERE raw_row_jsonb->>'reverses_homeowner_transaction_id' = dup_id::text) THEN
    RAISE EXCEPTION 'guard: the duplicate charge already has an offsetting credit';
  END IF;
  SELECT * INTO per FROM accounting_periods
   WHERE community_id = c AND DATE '2026-08-31' BETWEEN period_start AND period_end AND status IN ('open', 'reopened');
  IF NOT FOUND THEN RAISE EXCEPTION 'guard: August 2026 is not open for Waterview'; END IF;

  -- ------------------------------------------- A1. reversal entry, dated 8/31
  INSERT INTO journal_entries (community_id, period_id, posting_date, reference, description, source_module, source_reference,
                               total_debits_cents, total_credits_cents, reverses_je_id, status, notes)
  VALUES (c, per.id, DATE '2026-08-31', next_je_reference(c, per.fiscal_year),
          'VOID: JE-2026-00232 — duplicate legal bill-back (already in Vantaca 7/31 AR)', 'reversal', orig_id::text,
          4200, 4200, orig_id, 'posted',
          'Reverses JE-2026-00232 posted 2026-08-31. Void reason: ' || why)
  RETURNING id INTO rev_id;
  INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, fund_id, debit_cents, credit_cents, memo, property_id, vendor_id, bank_account_id)
  SELECT rev_id, l.line_number, l.account_id, l.fund_id, l.credit_cents, l.debit_cents,
         'Reversal of JE-2026-00232: ' || coalesce(l.memo, ''), l.property_id, l.vendor_id, l.bank_account_id
    FROM journal_entry_lines l WHERE l.journal_entry_id = orig_id;
  UPDATE journal_entries SET status = 'voided', voided_at = now(), void_reason = why, void_reversal_je_id = rev_id WHERE id = orig_id;

  -- -------------------- A2. homeowner credit against the duplicate charge
  SELECT coalesce(sum(balance_cents), 0) INTO bal FROM v_homeowner_current_balance WHERE community_id = c AND vantaca_account_id = h.vantaca_account_id;
  INSERT INTO transaction_upload_batches (management_company_id, community_id, period_label, as_of_date, source_format, status, uploaded_by,
                                          row_count, account_count, total_charges_cents, total_payments_cents,
                                          min_transaction_date, max_transaction_date, committed_at, notes)
  SELECT cm.management_company_id, c, 'Legal Fees - correction', DATE '2026-08-31', 'manual', 'committed', 'migration_557',
         1, 1, 0, 0, DATE '2026-08-31', DATE '2026-08-31', now(), 'Reverses duplicate legal bill-back ' || dup_id || ': ' || why
    FROM communities cm WHERE cm.id = c
  RETURNING id INTO batch_id;
  INSERT INTO homeowner_transactions (source_batch_id, source_row_index, community_id, property_id, contact_id, tenure_id,
                                      trusted_account_number, vantaca_account_id, transaction_date, description, txn_type,
                                      charge_category, amount_cents, running_balance_cents, is_operator_override, notes, raw_row_jsonb)
  VALUES (batch_id, 0, c, h.property_id, h.contact_id, h.tenure_id, h.trusted_account_number, h.vantaca_account_id, DATE '2026-08-31',
          'Legal Fees - correction (reverses attorney bill-back)', 'adjustment', 'adjustment', -4200, bal - 4200, true,
          'Reverses duplicate legal bill-back ' || dup_id || ': ' || why,
          jsonb_build_object('source', 'migration_557', 'reverses_homeowner_transaction_id', dup_id,
                             'reverses_journal_entry_id', orig_id, 'reversal_journal_entry_id', rev_id,
                             'attorney_invoice_number', 'PS-INV343615', 'vantaca_charge_date', '2026-06-26'));

  -- ------------------------------------------------ B. Amazon line corrections
  IF NOT EXISTS (SELECT 1 FROM ap_invoices WHERE id = inv_id AND community_id = c AND status = 'awaiting_approval'
                    AND posting_journal_entry_id IS NULL AND total_cents = 3404 AND tax_cents = 259
                    AND vendor_invoice_number = '112-0467422-8439405') THEN
    RAISE EXCEPTION 'guard: Amazon bill 112-0467422-8439405 is not the unposted $34.04 bill reviewed';
  END IF;
  SELECT count(*) INTO n FROM ap_invoice_lines WHERE invoice_id = inv_id;
  IF n <> 4 OR (SELECT sum(amount_cents) FROM ap_invoice_lines WHERE invoice_id = inv_id) <> 2406 THEN
    RAISE EXCEPTION 'guard: the Amazon lines are not the four reviewed lines totalling $24.06';
  END IF;
  UPDATE ap_invoice_lines SET quantity = 3, unit_price_cents = 499, amount_cents = 1497,
         notes = 'Corrected by migration 557 to the receipt: 3 packs x $4.99 (was $4.99)'
   WHERE id = '6d97bd3a-499b-41f0-ad7a-48868055f90a' AND invoice_id = inv_id AND amount_cents = 499;
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'guard: napkins line not corrected'; END IF;
  DELETE FROM ap_invoice_lines
   WHERE id = '6f144203-22aa-45c5-8915-73752720afe6' AND invoice_id = inv_id AND amount_cents = 259 AND description = 'Estimated tax to be collected';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION 'guard: duplicate tax line not removed'; END IF;
  UPDATE ap_invoices SET notes = coalesce(notes || E'\n', '') ||
         'Migration 557: lines corrected to the Amazon receipt (napkins 3 x $4.99 = $14.97, was $4.99; the $2.59 tax line removed because tax is already in the header). Lines 31.45 + tax 2.59 = total 34.04.'
   WHERE id = inv_id;
END
$m557$;

COMMIT;

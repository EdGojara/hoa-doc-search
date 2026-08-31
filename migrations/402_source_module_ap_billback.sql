-- ============================================================================
-- 402_source_module_ap_billback.sql  (Ed 2026-08-31)
-- ----------------------------------------------------------------------------
-- The attorney bill-back engine (lib/ap/legal_billback.js) posts its GL entry
-- with source_module = 'ap_billback' (DR 1300 Accounts Receivable / CR AP), to
-- distinguish a recoverable legal fee billed to a homeowner from a normal AP
-- expense accrual. But 'ap_billback' was never added to the journal_entries
-- source_module CHECK constraint, so every real post fails with
-- journal_entries_source_module_check — which is exactly why the $42 Martinez
-- reclass (PS-INV343615) never moved off 5870.
--
-- It slipped through because tests/test_legal_billback.js injects a fake JE
-- poster and never exercises the live constraint (the "test what ships, not what
-- parses" scar). Add the value so the engine can actually post.
-- ============================================================================
BEGIN;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_module_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_module_check
  CHECK (source_module IN (
    'manual','assessment_billing','payment_intake','bank_reconciliation',
    'vantaca_import','ar_snapshot','reserve_transfer','closing_entry',
    'opening_entry','reversal','system','ap_invoice','certified_letter_fee',
    'ap_billback'
  ));

COMMIT;

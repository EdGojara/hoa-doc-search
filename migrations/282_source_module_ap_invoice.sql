-- ============================================================================
-- 282_source_module_ap_invoice.sql  (Ed 2026-07-11)
-- ----------------------------------------------------------------------------
-- Emma's scan/email AP intake now auto-posts the invoice accrual to the GL
-- (Dr coded expense / Cr Accounts Payable) so a bill hits the books with no
-- touch — the only human step is approving the check run. Give those accruals
-- their own source_module so they're identifiable (vs a hand-keyed 'manual' JE).
-- ============================================================================
BEGIN;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS journal_entries_source_module_check;
ALTER TABLE journal_entries ADD CONSTRAINT journal_entries_source_module_check
  CHECK (source_module IN (
    'manual', 'assessment_billing', 'payment_intake',
    'bank_reconciliation', 'vantaca_import', 'ar_snapshot',
    'reserve_transfer', 'closing_entry', 'opening_entry',
    'reversal', 'system', 'ap_invoice'
  ));

COMMIT;

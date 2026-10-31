-- ============================================================================
-- 551_vantaca_receipts_idempotency.sql  (Ed 2026-10-31)
-- ----------------------------------------------------------------------------
-- Post-cutover Vantaca homeowner receipts (lib/ar/vantaca_receipts.js) post once,
-- whoever runs the import and however often:
--   * a homeowner ledger row from this import carries raw_row_jsonb.vantaca_ref
--     (the receipt's Vantaca identity); the same ref can exist once per community;
--   * the GL entry for one bank settlement carries source_reference 'VRCPT:...';
--     the same reference can exist once per community.
-- The two report types join the vantaca_imports source registry, where the
-- original files are kept (association_record).
--
-- Additive only: two partial unique indexes and a wider CHECK list. No existing
-- row qualifies for either index today (no 'vantaca_receipt' rows, no 'VRCPT:'
-- references), so the indexes build without touching data. Canyon Gate's
-- 2026-10-11 receipt rows (sources vantaca_pay_payout_contents /
-- vantaca_deposit_register) are left as they are; the importer recognizes them.
-- ============================================================================
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_homeowner_txn_vantaca_receipt
  ON homeowner_transactions (community_id, (raw_row_jsonb->>'vantaca_ref'))
  WHERE raw_row_jsonb->>'source' = 'vantaca_receipt';

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_vantaca_receipt_ref
  ON journal_entries (community_id, source_reference)
  WHERE source_reference LIKE 'VRCPT:%';

ALTER TABLE vantaca_imports DROP CONSTRAINT IF EXISTS vantaca_imports_report_type_check;
ALTER TABLE vantaca_imports
  ADD CONSTRAINT vantaca_imports_report_type_check
  CHECK (report_type IS NULL OR report_type IN (
    'ar_aging',
    'gl_export',
    'ap_ledger',
    'bank_reconciliation',
    'check_register',
    'owner_statement',
    'transaction_history',
    'trial_balance',
    'vendor_history',
    'budget_actual',
    'unknown',
    'vantaca_pay_payouts',   -- this migration
    'deposit_register'       -- this migration
  ));

COMMIT;

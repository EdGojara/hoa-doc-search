-- ============================================================================
-- 197_vantaca_imports_more_report_types.sql
-- ----------------------------------------------------------------------------
-- The classifier (lib/vantaca/classifier.js) and the extractor registry
-- (api/vantaca_imports.js) both reference report_type values that are NOT
-- in the original CHECK constraint from migration 168:
--   - 'transaction_history' (Owner ledger / Vantaca "Transaction History
--      — Association" report). Extractor exists at
--      lib/vantaca/extractors/transaction_history.js.
--   - 'trial_balance'       (GL Trial Balance — migration substrate).
--      Extractor exists at lib/vantaca/extractors/trial_balance.js.
--
-- When the classifier sets one of these and the API tries to INSERT,
-- Postgres rejects the row with a CHECK constraint violation. The
-- import never lands, the extractor never runs, the operator sees a
-- cryptic error from PostgREST.
--
-- This migration expands the CHECK to include both report types.
-- Idempotent.
-- ============================================================================

BEGIN;

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
    'transaction_history',   -- per-owner full ledger; this migration
    'trial_balance',         -- GL trial balance; this migration
    'vendor_history',
    'budget_actual',
    'unknown'
  ));

COMMENT ON COLUMN vantaca_imports.report_type IS
  'Classifier output (or operator override). Each value has an entry in api/vantaca_imports.js getExtractorForReportType() — some have working extractors, others are no-op placeholders that mark the row as classified-but-not-extracted.';

COMMIT;

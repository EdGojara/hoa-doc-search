-- ============================================================================
-- 239_bank_rec_source_reports.sql
-- ----------------------------------------------------------------------------
-- Wire the three Vantaca source reports directly into a bank reconciliation:
--   • Deposit Register     — the book deposit side (individual payments)
--   • Vantaca Pay Payouts  — authoritative online settlement detail
--   • Check Register       — issued checks (outstanding-check side)
--
-- Each is uploaded as an .xls, parsed by lib/banking/extractors/*, retained in
-- the documents bucket + library_documents, and its parsed structure stored on
-- the rec as jsonb so run-match can feed the matcher without re-parsing. Each
-- jsonb holds { storage_path, source_document_id, parsed: {...} }.
--
-- Record ownership: association_record (the HOA's bank rec workpapers/source).
-- Grants inherit from bank_reconciliations (granted in migration 233).
-- ============================================================================

BEGIN;

ALTER TABLE bank_reconciliations
  ADD COLUMN IF NOT EXISTS deposit_register_data jsonb,
  ADD COLUMN IF NOT EXISTS vantaca_payout_data   jsonb,
  ADD COLUMN IF NOT EXISTS check_register_data   jsonb;

COMMENT ON COLUMN bank_reconciliations.deposit_register_data IS 'Parsed Vantaca Deposit Register (book deposit side) + retained source path';
COMMENT ON COLUMN bank_reconciliations.vantaca_payout_data   IS 'Parsed Vantaca Pay Payout Contents (online settlement detail) + retained source path';
COMMENT ON COLUMN bank_reconciliations.check_register_data   IS 'Parsed Vantaca Check Register (outstanding-check side) + retained source path';

COMMIT;

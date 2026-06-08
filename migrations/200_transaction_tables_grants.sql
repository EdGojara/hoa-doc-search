-- ============================================================================
-- 200_transaction_tables_grants.sql
-- ----------------------------------------------------------------------------
-- Ed 2026-06-08 (third time tonight) — Migration 195 created
-- transaction_upload_batches + homeowner_transactions but FORGOT to GRANT
-- access to service_role. Extractor write failed with:
--   "permission denied for table transaction_upload_batches"
--
-- Same scar as migrations 168 (fixed by 196) and others before that.
-- A new CLAUDE.md rule is being added so this stops repeating.
-- Idempotent — safe to re-run.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_upload_batches TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON homeowner_transactions     TO service_role;

GRANT SELECT ON transaction_upload_batches TO authenticated;
GRANT SELECT ON homeowner_transactions     TO authenticated;

COMMIT;

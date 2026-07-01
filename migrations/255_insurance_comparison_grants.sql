-- ============================================================================
-- 255_insurance_comparison_grants.sql  (Ed 2026-07-01)
-- ----------------------------------------------------------------------------
-- Scar fix: migration 163 created insurance_comparisons + insurance_quotes but
-- never granted service_role. The Node API (service role) hits
-- "permission denied for table insurance_comparisons" (42501) → the Insurance
-- Renewals list 500s ("Failed to load: HTTP 500"). Same class as the
-- vantaca_imports / transaction_upload_batches grant scars. Idempotent.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON insurance_comparisons TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON insurance_quotes      TO service_role;
GRANT SELECT ON insurance_comparisons TO authenticated;
GRANT SELECT ON insurance_quotes      TO authenticated;

COMMIT;

-- ============================================================================
-- 244_check_register_grant.sql
-- ----------------------------------------------------------------------------
-- Migration 176 created check_register but never granted service_role. The
-- Node API uses the service role for all writes, so every check-run INSERT
-- failed with "permission denied for table check_register" — the recurring
-- "new table without a GRANT is silently unwritable" scar (see CLAUDE.md).
-- Idempotent.
-- ============================================================================

BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON check_register TO service_role;
GRANT SELECT                          ON check_register TO authenticated;

COMMIT;

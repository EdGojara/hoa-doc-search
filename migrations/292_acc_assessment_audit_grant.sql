-- ============================================================================
-- 292_acc_assessment_audit_grant.sql  (Ed 2026-07-13)
-- ----------------------------------------------------------------------------
-- Scar fix: migration 118 created acc_assessment_audit but never granted the
-- service role, so every ACC assessment logged "permission denied for table
-- acc_assessment_audit" and its audit row was lost. (CLAUDE.md: "New tables
-- without service_role GRANTs are silently unwritable.")
-- ============================================================================
BEGIN;

GRANT SELECT, INSERT, UPDATE, DELETE ON acc_assessment_audit TO service_role;
GRANT SELECT                          ON acc_assessment_audit TO authenticated;

COMMIT;
